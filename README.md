# homebridge-reolink-hksv-doorbell

Homebridge-Plugin für Reolink-Kameras und -Video-Türklingeln mit Unterstützung für
**HomeKit Secure Video (HKSV)**. Die komplette Konfiguration erfolgt bequem über die
Homebridge-UI (`homebridge-config-ui-x`) — es muss keine `config.json` von Hand bearbeitet werden.

## Funktionen

- **Türklingel**: Reolink-Video-Türklingeln werden als HomeKit-`Doorbell` angezeigt. Ein
  Klingel-Ereignis löst eine Push-Benachrichtigung in der Home-App aus.
- **Bewegungssensor**: Optionaler HomeKit-Bewegungssensor, basierend auf PIR- und/oder
  KI-Erkennung (Personen, Fahrzeuge, Tiere) der Kamera.
- **HomeKit Secure Video**: Aufzeichnung von Ereignissen (Klingeln/Bewegung) direkt in
  iCloud, inklusive Prebuffer (Aufnahme beginnt bereits kurz *vor* dem Ereignis).
- **Live-Ansicht**: Live-Video (und optional Audio) direkt in der Home-App.
- **Mehrere Kameras**: Beliebig viele Reolink-Kameras/-Türklingeln gleichzeitig, auch
  Kanäle hinter einem Reolink-NVR.
- **Vollständig über die Homebridge-UI konfigurierbar** (`config.schema.json`).

## Voraussetzungen

- Homebridge 1.8 oder neuer (Homebridge 2.x wird ebenfalls unterstützt).
- Node.js 18.15+, 20.7+ oder 22+.
- Eine Reolink-Kamera oder -Türklingel mit aktivierter HTTP(S)-API und RTSP
  (bei den meisten Modellen standardmäßig aktiv; ggf. in der Reolink-App/-Weboberfläche
  unter *Netzwerk → Erweitert* prüfen).
- Für HomeKit Secure Video: ein HomeKit-Hub (Apple TV, HomePod oder ein zu Hause
  verbleibendes iPad) sowie ein iCloud-Speicherplan mit HomeKit-Secure-Video-Unterstützung.
- `ffmpeg`: Das Plugin installiert automatisch ein passendes, statisches `ffmpeg`-Binary
  (`ffmpeg-for-homebridge`). Falls für die jeweilige Plattform kein Binary verfügbar ist,
  kann in den Plugin-Einstellungen ein eigener Pfad zu einem installierten `ffmpeg`
  (mit `libx264`- und `libfdk_aac`-Unterstützung) hinterlegt werden.

## Installation

Über die Homebridge-UI: *Plugins* → nach `homebridge-reolink-hksv-doorbell` suchen →
*Installieren*.

Alternativ über die Kommandozeile:

```bash
npm install -g homebridge-reolink-hksv-doorbell
```

## Konfiguration

Nach der Installation erscheint das Plugin in der Homebridge-UI unter *Plugins* mit einem
*Einstellungen*-Button. Dort lässt sich für jede Kamera Folgendes festlegen:

| Einstellung | Beschreibung |
|---|---|
| Name | Anzeigename in HomeKit |
| IP-Adresse / Hostname | Adresse der Kamera, Türklingel oder des NVR |
| HTTP(S)-Port, Benutzername, Passwort | Zugangsdaten für die Reolink-API |
| HTTPS verwenden / Selbstsignierte Zertifikate akzeptieren | Reolink-Geräte nutzen meist HTTPS mit selbstsigniertem Zertifikat |
| Kanal | Bei einem NVR der Kanalindex der Kamera (0 = erster Kanal) |
| Als Türklingel anzeigen | Blendet den Klingel-Knopf ein/aus |
| Klingel-Ereignisquelle | Welches Ereignis (`visitor`, `people`, `md`, `mqtt`) als Klingeln gilt |
| Bewegungssensor aktivieren | Separater HomeKit-Bewegungssensor |
| HomeKit Secure Video aktivieren | Aktiviert die HKSV-Aufnahmepipeline |
| Live-/Aufnahme-Stream | Welcher Reolink-Stream (`main`/`sub`/`ext`) für Live-Ansicht bzw. HKSV verwendet wird |
| Prebuffer-/Fragment-Länge | Feinjustierung der HKSV-Aufnahme |

Eine manuelle `config.json` sieht z. B. so aus:

```json
{
  "platforms": [
    {
      "platform": "ReolinkHksvDoorbell",
      "cameras": [
        {
          "name": "Haustür",
          "host": "192.168.1.50",
          "username": "admin",
          "password": "geheim",
          "isDoorbell": true,
          "ringTrigger": "visitor",
          "enableMotion": true,
          "enableHksv": true,
          "liveStream": "main",
          "recordingStream": "sub"
        }
      ]
    }
  ]
}
```

### Hinweise zur Klingel-Erkennung

Reolink-Video-Türklingeln melden einen Tastendruck als `visitor`-Ereignis über die
Geräte-API. Bei Modellen/Firmwareständen, die dieses Feld (noch) nicht liefern, kann
alternativ die Personenerkennung (`people`) oder der reine Bewegungsmelder (`md`) als
Klingel-Auslöser konfiguriert werden.

### Klingeln über MQTT (für normale Kameras ohne Klingel-Knopf)

Hast du nur eine normale Reolink-Kamera (keine Video-Türklingel), kannst du das Klingeln
trotzdem in HomeKit abbilden — ähnlich wie bei Scrypted per "Dummy-Switch": Ein externes
System (z. B. Home Assistant, Scrypted, ein Taster mit MQTT-Anbindung) veröffentlicht eine
Nachricht auf ein MQTT-Topic, das Plugin hört auf dieses Topic und löst daraufhin die
HomeKit-Türklingel aus (inkl. HKSV-Aufnahme, falls aktiviert).

1. In den Plugin-Einstellungen unter *MQTT-Broker* die Verbindung zu deinem MQTT-Broker
   konfigurieren (Host, Port, ggf. Zugangsdaten) und aktivieren.
2. Bei der jeweiligen Kamera unter *Türklingel & Sensoren*:
   - *Als Türklingel (Doorbell) anzeigen* aktivieren
   - *Klingel-Ereignisquelle* auf **MQTT** stellen
   - *MQTT-Topic für Klingeln* setzen, z. B. `home/haustuer/ring`
   - Optional *Erwartetes MQTT-Payload* setzen (z. B. `ON` oder `PRESSED`), falls das Topic
     auch für andere Zustände verwendet wird. Leer lassen, wenn jede Nachricht auf dem Topic
     als Klingeln zählen soll.
3. Dein externes System veröffentlicht bei einem Klingel-Ereignis eine (nicht-retained)
   Nachricht auf genau diesem Topic — z. B. über eine Home-Assistant-Automation mit einer
   `mqtt.publish`-Aktion, oder direkt über `mosquitto_pub -t home/haustuer/ring -m ON`.

Retained Nachrichten (der beim (Re-)Verbinden automatisch vom Broker "nachgelieferte"
letzte bekannte Wert eines Topics) werden bewusst ignoriert, damit nicht bei jedem
Homebridge-Neustart ein Phantom-Klingeln ausgelöst wird — es zählt nur eine frisch
eintreffende Nachricht.

Motion-Erkennung läuft bei `ringTrigger: mqtt` unverändert normal über die Reolink-API
weiter (sofern *Bewegungssensor aktivieren* eingeschaltet ist); nur die Klingel-Quelle
wird ersetzt.

### Wie HKSV funktioniert

Ist HomeKit Secure Video für eine Kamera aktiviert, läuft im Hintergrund dauerhaft ein
`ffmpeg`-Prozess, der den Reolink-Stream in ein für HomeKit passendes, fragmentiertes
MP4-Format transkodiert und die letzten Sekunden (Prebuffer) im Arbeitsspeicher
vorhält. Löst die Kamera ein Bewegungs- oder Klingelereignis aus, fordert die Home-App
die Aufnahme an — das Plugin liefert dann zunächst den Prebuffer-Inhalt (Kontext *vor*
dem Ereignis) und anschließend fortlaufend neue Aufnahme-Fragmente.

Da hierfür kontinuierlich transkodiert wird, sollte für die Aufnahme-Pipeline nach
Möglichkeit der niedriger auflösende Substream (`sub`) der Kamera verwendet werden, um
die CPU-Last gering zu halten (Standardeinstellung).

## Bekannte Einschränkungen

- Keine Gegensprechfunktion (Zwei-Wege-Audio) über HomeKit; Live-Ansicht und HKSV-Audio
  laufen nur in eine Richtung (Kamera → HomeKit).
- Ereignisse (Klingeln/Bewegung) werden per Polling der Reolink-API abgefragt (Standard:
  alle 2 Sekunden), nicht per Push/ONVIF-Abo. Das Intervall ist konfigurierbar.
- PTZ-Steuerung wird nicht unterstützt.

## Fehlersuche

- Debug-Logging (inkl. vollständiger `ffmpeg`-Ausgabe) kann in den Plugin-Einstellungen
  aktiviert werden.
- Bei Verbindungsproblemen zunächst prüfen, ob die Reolink-API und RTSP über die
  angegebenen Zugangsdaten/Ports erreichbar sind (z. B. mit der Reolink-App oder einem
  RTSP-Client wie VLC).
- Schlägt die Live-Ansicht mit Zertifikatsfehlern fehl, sicherstellen, dass
  *Selbstsignierte Zertifikate akzeptieren* aktiviert ist (Standard).

## Lizenz

MIT
