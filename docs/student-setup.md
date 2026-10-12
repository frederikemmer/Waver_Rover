# Erststart für Studierende

`student-setup.sh` aktualisiert Raspberry Pi OS und bereitet einen Rover für
eigene Entwicklungen vor. Es installiert **nicht** die fertige WAVE-ROVER-
Steuerungsanwendung und kopiert keinen Anwendungscode auf den Pi.

## Start

Das Script kann einzeln geladen und direkt ausgeführt werden:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | sudo bash
~~~

Auf einem Raspberry Pi 5, auf dem `dtoverlay=uart0-pi5` noch fehlt, ergänzt der
erste Aufruf die UART-Einstellung und beendet sich. Starte den Pi mit
`sudo reboot` neu und führe denselben Befehl noch einmal aus.

Das Script wählt einen zufälligen Hostnamen `roverXX`; `XX` sind zwei Ziffern
von `00` bis `99`. Der Name bleibt über Neustarts erhalten. Ein Dienst prüft
beim Hochfahren über Avahi/mDNS, ob dieser Name bereits im lokalen Netz
antwortet. Bei einem Konflikt wählt er eine andere freie Nummer und aktualisiert
das OLED. Wenn beim Start kein IPv4-Netz aktiv ist, bleibt der Name unverändert
und wird beim nächsten Boot erneut geprüft. `.local` gehört zum Verbindungsnamen,
aber nicht zum Linux-Hostname.

Danach setzt das Script ein neues Passwort für den aufrufenden Linux-Benutzer.
Enter erzeugt ein zufälliges vierstelliges Passwort. Ein eigenes Passwort muss
ebenfalls genau vier Kleinbuchstaben oder Ziffern enthalten. `i`, `l`, `o`, `0`
und `1` werden ausgeschlossen, damit die Zeichen auf dem OLED leichter zu
unterscheiden sind. Das Passwort erscheint nicht im Terminal.

Das OLED zeigt den vollständigen mDNS-Namen, die IPv4-Adresse, den Benutzer und
`password:` samt Passwort. Die IP ist ein Fallback,
falls ein Laptop `.local` nicht auflösen kann; solange das Netzwerk keine
IPv4-Adresse vergeben hat, steht dort `offline`. Im selben vertrauenswürdigen
Netzwerk können Studierende zum Beispiel verbinden mit:

~~~bash
ssh pi@roverXX.local
~~~

Ersetze `pi` und `XX` durch den auf dem OLED angezeigten Benutzernamen und die
beiden Hostnamen-Ziffern. Alternativ kann die angezeigte IP-Adresse verwendet
werden. Pi und Laptop müssen dasselbe Netzwerk erreichen; dieses muss mDNS für
`.local`-Namen erlauben.

## Was eingerichtet wird

- `apt-get update`, ein vollständiges Paket-Upgrade und `apt autoremove`
- Python 3, `pip`, `venv`, `setuptools`, Git und pySerial
- OpenSSH mit Passwortanmeldung, Avahi und `avahi-utils` für `.local`-Hostnamen
- der serielle Zugriff des Pi auf den ESP32-Rovercontroller
- vier OLED-Zeilen: `roverXX.local`, IPv4-Adresse, Benutzer und `password: xxxx`
- ein Startdienst, der einen belegten Hostnamen beim Boot neu auswählt
- ein Startdienst, der Hostname und Netzwerkadresse nach jedem Neustart erneut
  auf dem OLED anzeigt
- eine Abhängigkeit, die den OLED-Dienst vor dem später optional installierten
  `wave-rover-control`-Dienst ausführt und den UART anschließend freigibt

Die Klartext-Zugangsdaten werden unter
`/etc/wave-rover-student/credentials.json` mit Dateirechten `0600` gespeichert,
damit das OLED nach einem Neustart wieder beschrieben werden kann. Das ist
notwendig, weil das Display vom ESP32 gesteuert wird. Wer am Rover-OLED steht,
kann das SSH-Passwort lesen. Außerdem kann ein Benutzer mit `sudo` diese Datei
lesen. Das vierstellige Passwort ist absichtlich leicht abzutippen und bietet
keinen starken Schutz gegen Erraten. Verwende es nur in einem vertrauenswürdigen
Kursnetz und leite SSH-Port 22 nicht aus dem Internet weiter. Wenn das Passwort
später außerhalb des Scripts geändert wird, muss das Script erneut laufen;
dabei setzt es ein neues Passwort und aktualisiert die OLED-Anzeige.

## Optionale Einstellungen

Die Befehlszeilenoptionen lassen sich kombinieren. Ohne Interface-Optionen
bleiben I²C, SPI und VNC ausgeschaltet.

| Einstellung | Standard | Wirkung |
| --- | --- | --- |
| Eigenes SSH-Passwort eingeben | Zufälliges Passwort erzeugen | Enter erzeugt ein neues vierstelliges Passwort aus Kleinbuchstaben und Ziffern ohne `i`, `l`, `o`, `0` oder `1`. Ein eigenes Passwort muss denselben Regeln entsprechen. Bei jedem vollständigen Script-Lauf wird das Passwort neu gesetzt. |
| `--enable-i2c` | Aus | Aktiviert I²C über `raspi-config`; für zusätzliche I²C-Sensoren. |
| `--enable-spi` | Aus | Aktiviert SPI über `raspi-config`; für zusätzliche SPI-Geräte. |
| `--enable-vnc` | Aus | Versucht VNC über `raspi-config` zu aktivieren. Dafür ist ein Desktop auf dem Pi nötig; die Unterstützung hängt vom Raspberry-Pi-OS-Image ab. |
| `-h`, `--help` | – | Zeigt die Script-Hilfe an und beendet das Script ohne Setup. |

Der aktuelle Rover benötigt für den Pi-Controller UART und für die Kamera USB;
für SSH und den Erstzugriff müssen I²C, SPI und VNC daher nicht aktiviert
werden. Um beispielsweise I²C und SPI zusätzlich einzuschalten:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | sudo bash -s -- --enable-i2c --enable-spi
~~~

Alle drei Schnittstellenoptionen lassen sich bei Bedarf in einem Aufruf
kombinieren:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | sudo bash -s -- --enable-i2c --enable-spi --enable-vnc
~~~

Die Oberfläche des ESP32-WAVE-ROVER wird über JSON-Befehle angesprochen. Der
Befehl `T=3` setzt einzelne OLED-Zeilen; `T=-3` stellt die ursprüngliche
Statusanzeige wieder her. Details stehen in der
[Waveshare-Dokumentation zum OLED](https://www.waveshare.com/wiki/WAVE_ROVER#OLED_Screen_Setting).

## Eigene Entwicklung

Nach dem Erststart ist der Pi aktualisiert und per SSH erreichbar. Studierende
können dann eigene Dateien oder ein eigenes Repository übertragen und dort
entwickeln. Das separate `install.sh` installiert die fertige Browsersteuerung
und bleibt für diesen Erststart absichtlich außen vor.
