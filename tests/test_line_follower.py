import time
import unittest
from unittest.mock import Mock, patch

from wave_rover.drive import DriveController
from wave_rover.line_follower import LineFollower, DEFAULT_CONFIG, cv2, np


class StopDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.camera = Mock()
        self.drive = Mock()
        self.drive.max_speed = 0.5
        self.follower = LineFollower(self.camera, self.drive)
        self.follower._active = True
        self.follower._processed_revision = 0

    def good_frame(self, now):
        self.follower._apply_detection(
            {"line_detected": True, "steering_error": 0.25}, 0, now, DEFAULT_CONFIG
        )

    def lost_frame(self, now):
        return self.follower._apply_detection(
            {"line_detected": False, "rejection_reason": "Keine längliche Linie."},
            0, now, DEFAULT_CONFIG,
        )

    def test_short_loss_keeps_motors_running_and_recovers_without_restart(self):
        self.good_frame(10)
        self.assertFalse(self.lost_frame(10.1))
        self.drive.stop.assert_not_called()
        self.assertTrue(self.follower.active)
        self.assertEqual(self.follower.status()["state"], "line_recovering")
        self.drive.set_speeds.assert_called_once()
        args, kwargs = self.drive.set_speeds.call_args
        self.assertGreater(args[0], 0)
        self.assertGreater(args[1], 0)
        self.assertEqual(kwargs["valid_until"], 10.4)
        self.good_frame(10.399)
        self.assertTrue(self.follower.active)
        self.assertEqual(self.follower.status()["state"], "following")
        self.assertIsNone(self.follower.status()["error"])
        self.drive.stop.assert_not_called()

    def test_continuous_loss_does_not_extend_deadline_and_latches_stop(self):
        self.good_frame(10)
        self.lost_frame(10.1)
        self.lost_frame(10.3)
        self.assertEqual(self.drive.set_speeds.call_args.kwargs["valid_until"], 10.4)
        self.assertTrue(self.lost_frame(10.4))
        self.drive.stop.assert_called_once()
        self.drive.set_speeds.reset_mock()
        self.good_frame(10.5)
        status = self.follower.status()
        self.assertEqual(status["state"], "line_lost")
        self.assertEqual(status["error"], "Keine längliche Linie.")
        self.assertFalse(status["active"])
        self.follower._send_follow_command(0, DEFAULT_CONFIG)
        self.drive.set_speeds.assert_not_called()

    def test_first_good_frame_at_or_after_deadline_cannot_restart_motion(self):
        for recovery_at in (10.4, 10.7):
            with self.subTest(recovery_at=recovery_at):
                self.setUp()
                self.good_frame(10)
                self.lost_frame(10.1)
                self.good_frame(recovery_at)
                self.assertFalse(self.follower.active)
                self.assertEqual(self.follower.status()["state"], "line_lost")
                self.drive.stop.assert_called_once()

    def test_manual_stop_during_grace_cancels_any_automatic_recovery(self):
        self.good_frame(10)
        self.lost_frame(10.1)
        self.follower.stop()
        self.drive.set_speeds.reset_mock()
        self.good_frame(10.2)
        self.follower._send_follow_command(0.25, DEFAULT_CONFIG)
        self.drive.set_speeds.assert_not_called()
        self.assertFalse(self.follower.active)
        self.drive.stop.assert_called_once()

    def test_pending_loss_expires_even_without_another_camera_frame(self):
        self.good_frame(10)
        self.lost_frame(10.1)
        self.camera.status.return_value = {"state": "online"}
        with patch("wave_rover.line_follower.time.monotonic", return_value=10.4):
            self.follower._stop_if_camera_lost()
        self.assertFalse(self.follower.active)
        self.assertEqual(self.follower.status()["state"], "line_lost")
        self.drive.stop.assert_called_once()

    def test_motor_deadline_expires_independently_if_vision_processing_stalls(self):
        drive = DriveController("none", 115200, 0.5, 450)
        self.follower.drive = drive
        self.good_frame(10)
        with patch("wave_rover.drive.time.monotonic", return_value=10):
            self.follower._send_follow_command(0.25, DEFAULT_CONFIG)
        with patch("wave_rover.drive.time.monotonic", return_value=10.1):
            self.lost_frame(10.1)
        with patch("wave_rover.drive.time.monotonic", return_value=10.3):
            self.lost_frame(10.3)
            self.assertNotEqual(drive._current_command(), (0, 0))
        with patch("wave_rover.drive.time.monotonic", return_value=10.4):
            self.assertEqual(drive._current_command(), (0, 0))

    def test_separate_short_losses_each_get_their_own_grace_period(self):
        self.good_frame(10)
        self.lost_frame(10.1)
        self.good_frame(10.2)
        self.lost_frame(10.3)
        self.assertAlmostEqual(self.drive.set_speeds.call_args.kwargs["valid_until"], 10.6)
        self.assertTrue(self.follower.active)
        self.drive.stop.assert_not_called()

    def test_camera_stop_reason_survives_recovered_frames(self):
        self.camera.status.return_value = {"state": "offline"}
        self.good_frame(10)
        self.lost_frame(10.1)
        with patch("wave_rover.line_follower.time.monotonic", return_value=10.2):
            self.follower._stop_if_camera_lost()
        self.follower._apply_detection({"line_detected": True}, 0, time.monotonic(), DEFAULT_CONFIG)
        self.assertEqual(self.follower.status()["state"], "camera_lost")
        self.assertIn("Kamerabild", self.follower.status()["error"])
        self.assertFalse(self.follower.active)

    @unittest.skipIf(cv2 is None or np is None, "OpenCV not installed")
    def test_explicit_restart_clears_latched_reason(self):
        follower = self.follower
        self.good_frame(10)
        self.lost_frame(10.1)
        self.lost_frame(10.4)
        self.good_frame(time.monotonic())
        self.camera.status.return_value = {"state": "online"}
        self.drive.status.return_value = {"state": "connected"}
        status = follower.start_following()
        self.assertTrue(status["active"])
        self.assertEqual(status["state"], "following")
        self.assertIsNone(status["error"])


@unittest.skipIf(cv2 is None or np is None, "OpenCV not installed")
class DetectionDiagnosisTests(unittest.TestCase):
    def analyze(self, rectangles, mode="single"):
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        for x0, y0, x1, y1 in rectangles:
            cv2.rectangle(frame, (x0, y0), (x1, y1), (255, 255, 255), -1)
        okay, jpeg = cv2.imencode(".jpg", frame)
        self.assertTrue(okay)
        config = {**DEFAULT_CONFIG, "line_mode": mode, "min_area_percent": 0.05}
        return LineFollower(Mock(), Mock())._analyze(jpeg.tobytes(), config)[0]

    def test_valid_line_has_no_rejection(self):
        detection = self.analyze([(310, 280, 330, 479)])
        self.assertTrue(detection["line_detected"])
        self.assertIsNone(detection["rejection_reason"])

    def test_low_minimum_area_does_not_disable_shape_filter(self):
        square = [(300, 350, 330, 380)]
        line_mode = self.analyze(square)
        self.assertFalse(line_mode["line_detected"])
        self.assertIn("Seitenverhältnis", line_mode["rejection_reason"])
        self.assertTrue(self.analyze(square, mode="area")["line_detected"])

    def test_double_line_requires_two_lines_and_spacing(self):
        single = self.analyze([(310, 280, 320, 479)], mode="between")
        self.assertIn("weniger als zwei", single["rejection_reason"])
        close = self.analyze([(300, 280, 310, 479), (350, 280, 360, 479)], mode="between")
        self.assertIn("Abstand", close["rejection_reason"])

    def test_empty_and_oversized_masks_explain_rejection(self):
        self.assertIn("Rauschfilter", self.analyze([])["rejection_reason"])
        self.assertIn("zu groß", self.analyze([(0, 0, 639, 479)])["rejection_reason"])

    def test_individually_small_fragments_are_not_summed(self):
        fragments = [(x, 350, x + 5, 355) for x in range(100, 500, 20)]
        self.assertIn("Mindestfläche", self.analyze(fragments)["rejection_reason"])


if __name__ == "__main__":
    unittest.main()
