# Erststart für Studierende

`student-setup.sh` aktualisiert Raspberry Pi OS und bereitet einen Rover für
eigene Entwicklungen vor. Es installiert **nicht** die fertige WAVE-ROVER-
Steuerungsanwendung und kopiert keinen Anwendungscode auf den Pi.

## Start

Das Script kann einzeln geladen und direkt ausgeführt werden:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | sudo bash
~~~

Normalerweise zeigt das Script einen farbigen Ladebalken mit geschätzter
Restzeit und dem aktuellen Arbeitsschritt. Mit `--debug` werden zusätzlich die
Ausgaben der Setup-Befehle angezeigt.

Du kannst beim selben Aufruf ein WLAN einrichten. SSID und Passwort müssen
zusammen angegeben werden:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | \
  sudo bash -s -- --wifi-ssid "Kurs WLAN" --wifi-password "WLAN-Passwort"
~~~

Wenn das Script schon auf dem Pi liegt, kannst du es auch direkt starten:

~~~bash
sudo bash ./student-setup.sh --wifi-ssid "Kurs WLAN" --wifi-password "WLAN-Passwort"
~~~

Das Script verbindet über NetworkManager, falls dieser läuft, und verwendet
sonst `raspi-config`.

Das WLAN-Passwort wird nicht in der OLED-Zugangsdaten-Datei gespeichert. Weil
es als Befehlszeilenparameter übergeben wird, kann es während des Aufrufs in
der Shell-History oder Prozessliste sichtbar sein. Führe den Befehl daher nur
in einer vertrauenswürdigen Einrichtungssitzung aus. Bei Fehlern kannst du
`--debug` ergänzen, um die Befehlsausgaben zu sehen.

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

Das OLED zeigt in beiden Installationsvarianten dieselben vier Zeilen:

~~~text
192.168.1.42
rover42.local
u: pi - p: abcd
80 % - 12.00 V
~~~

IP, tatsächlicher Linux-Hostname und gespeicherte Zugangsdaten werden alle zwei
Sekunden neu gelesen. Die Anzeige wird fortlaufend geschrieben, auch wenn das
Netzwerk erst später verfügbar ist. Werte über 21 Zeichen scrollen innerhalb
ihrer Zeile, damit sie keine andere Zeile überschreiben. Nicht darstellbare
Zeichen außerhalb des druckbaren ASCII-Zeichensatzes erscheinen als `?`.
Die Prozentangabe ist dieselbe grobe 3S-Li-Ion-Spannungsschätzung wie im
Webinterface. Fehlt länger als fünf Sekunden ein gültiger Messwert, steht in
der letzten Zeile `-- % - -- V`.

Die IP ist ein Fallback,
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
- vier OLED-Zeilen: IPv4-Adresse, `roverXX.local`, `u: BENUTZER - p: PASSWORT`, Akkuprozent und Spannung
- ein Startdienst, der einen belegten Hostnamen beim Boot neu auswählt
- ein dauerhaft laufender OLED-Dienst für Netzwerk, Zugangsdaten und Akkuwerte
- ein früher Startdienst, der alte benutzerdefinierte OLED-Zeilen explizit leert
- bei späterer Webinstallation übernimmt der Rover-Control-Dienst die OLED-Ausgabe
  über seine bestehende UART-Verbindung; der separate OLED-Dienst wird deaktiviert

Die Klartext-Zugangsdaten werden unter
`/etc/wave-rover-student/credentials.json` mit Dateirechten `0600` gespeichert,
damit das OLED nach einem Neustart wieder beschrieben werden kann. Das ist
notwendig, weil das Display vom ESP32 gesteuert wird. Wer am Rover-OLED steht,
kann das SSH-Passwort lesen. Außerdem kann ein Benutzer mit `sudo` diese Datei
lesen. Das vierstellige Passwort ist absichtlich leicht abzutippen und bietet
keinen starken Schutz gegen Erraten. Verwende es nur in einem vertrauenswürdigen
Kursnetz und leite SSH-Port 22 nicht aus dem Internet weiter. Wenn das Passwort
später außerhalb des Scripts geändert wird, muss das Script erneut laufen;
dabei setzt es ein neues Passwort und aktualisiert die OLED-Anzeige. Bei der
Webinstallation genügt ein erneuter Aufruf von `install.sh`: Er prüft das
hinterlegte Passwort gegen das Linux-Konto und fragt bei Bedarf das aktuelle
Passwort verdeckt ab, ohne es zu ändern. Ein laufender Webdienst erhält die
Zugangsdaten über systemds geschütztes `LoadCredential`; seine Kopie wird beim
Dienstneustart erneuert. Außerhalb der Installer geänderte Login-Passwörter
können nicht automatisch aus Linux ausgelesen werden.

## Optionale Einstellungen

Die Befehlszeilenoptionen lassen sich kombinieren. Ohne Interface-Optionen
bleiben I²C, SPI und VNC ausgeschaltet.

| Einstellung | Standard | Wirkung |
| --- | --- | --- |
| Eigenes SSH-Passwort eingeben | Zufälliges Passwort erzeugen | Enter erzeugt ein neues vierstelliges Passwort aus Kleinbuchstaben und Ziffern ohne `i`, `l`, `o`, `0` oder `1`. Ein eigenes Passwort muss denselben Regeln entsprechen. Bei jedem vollständigen Script-Lauf wird das Passwort neu gesetzt. |
| `--wifi-ssid SSID --wifi-password PASSWORT` | Bestehende Netzwerkeinstellung verwenden | Verbindet vor den Paket-Updates mit dem WLAN. Beide Optionen sind erforderlich. Das Passwort wird in der WLAN-Konfiguration des Pi gespeichert, aber nicht in der OLED-Zugangsdaten-Datei. |
| `--enable-i2c` | Aus | Aktiviert I²C über `raspi-config`; für zusätzliche I²C-Sensoren. |
| `--enable-spi` | Aus | Aktiviert SPI über `raspi-config`; für zusätzliche SPI-Geräte. |
| `--enable-vnc` | Aus | Versucht VNC über `raspi-config` zu aktivieren. Dafür ist ein Desktop auf dem Pi nötig; die Unterstützung hängt vom Raspberry-Pi-OS-Image ab. |
| `--debug` | Aus | Zeigt die Setup-Befehlsausgaben zusätzlich zum Fortschritt an. |
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

WLAN und Schnittstellenoptionen lassen sich kombinieren. Für ausführliche
Befehlsausgaben kann `--debug` am Ende ergänzt werden:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/student-setup.sh | \
  sudo bash -s -- --wifi-ssid "Kurs WLAN" --wifi-password "WLAN-Passwort" \
    --enable-i2c --enable-spi --debug
~~~

Die Oberfläche des ESP32-WAVE-ROVER wird über JSON-Befehle angesprochen. Der
Befehl `T=3` setzt einzelne OLED-Zeilen; `T=-3` stellt die ursprüngliche
Statusanzeige wieder her. Details stehen in der
[Waveshare-Dokumentation zum OLED](https://www.waveshare.com/wiki/WAVE_ROVER#OLED_Screen_Setting).

## Eigene Entwicklung

Nach dem Erststart ist der Pi aktualisiert und per SSH erreichbar. Studierende
können dann eigene Dateien oder ein eigenes Repository übertragen und dort
entwickeln. Solange nur die Studenten-Version installiert ist, belegt der
OLED-Dienst den UART. Vor eigenen UART-Programmen mit
`sudo systemctl stop wave-rover-student-oled.service` stoppen und danach mit
`sudo systemctl start wave-rover-student-oled.service` wieder starten.
Das separate `install.sh` installiert die fertige Browsersteuerung
und bleibt für diesen Erststart absichtlich außen vor.
