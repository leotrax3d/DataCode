# ▮▯▮ BlinkTransfer

Daten (z. B. einfacher Text) **optisch** von einem Bildschirm zu einer
Handykamera übertragen – über eine konfigurierbare Anzahl schwarz/weiß
**blinkender Balken**, ähnlich einem chipTAN-Flickercode. Reine statische
Website, läuft komplett offline und über **GitHub Pages**, ohne Backend.

## Funktionen

- **Zwei Übertragungsarten:**
  - **Licht** (optisch): blinkende Balken Bildschirm → Kamera.
  - **Audio** (akustisch): 16-Ton-FSK Lautsprecher → Mikrofon (4 Bit/Ton).
- **Je Senden & Empfangen** als eigener Reiter.
- **Text *und* Dateien:** Text eingeben oder Datei per Drag & Drop / Auswahl
  übertragen. Dateiname und MIME-Typ werden mitgesendet; der Empfänger bietet
  Download und (bei Bildern) eine Vorschau.
- **Fehlerkorrektur (FEC):** Reed-Solomon über GF(256), blockweise mit
  Interleaving gegen Bündelfehler – für Licht **und** Audio. Stufen
  Keine/Leicht/Mittel/Stark. Wird automatisch aus dem Header erkannt.
- **Schneller per Farben/Graustufen (optional):** Schwarz/Weiß (1 Bit/Balken),
  4 Graustufen (2 Bit) oder 8 Farben (3 Bit). Muss bei Sender & Empfänger
  gleich eingestellt sein.
- **Restzeit & Tempo:** Sender zeigt die geschätzte Dauer pro Durchlauf,
  Empfänger zeigt Fortschritt, voraussichtliche Restzeit und Datenrate.
- **Konfigurierbar:** Anzahl der Datenbalken (1–10) und Übertragungstempo.
- **Automatische Balkenerkennung:** Der Empfänger zählt die Balken selbst über
  ein Kalibrier-Streifenmuster am Anfang.
- **Robuste Selbst-Taktung:** Der linke *Takt-Balken* blinkt bei jedem Symbol,
  sodass die Abtastung unabhängig von der (schwankenden) Kamerabildrate ist.
- **Fehlererkennung:** Header mit Längenangabe und **CRC-16**-Prüfsumme. Der
  Empfänger prüft am Ende, ob die Nachricht vollständig und korrekt ist.
- **Fortschrittsbalken** und Live-Status (Balkenzahl, Kontrast, FPS).
- **Endlosschleife:** Die Übertragung wird wiederholt – eine fehlerhaft
  empfangene Kopie wird verworfen, der nächste Durchlauf gelingt.

## So funktioniert die Übertragung

```
[ Takt ][ D0 ][ D1 ] ... [ D(n-1) ]      <- Balken auf dem Sender-Bildschirm
   |       \________ Datenbits ________/
   |
   └─ blinkt jedes Symbol (Selbst-Taktung)
```

Ablauf je Durchlauf:

1. **Kalibrierung** – ein invertierendes Streifenmuster, an dem der Empfänger
   die Balken findet und zählt.
2. **Header + Nutzdaten** als Bitstrom, in Symbole zu je *n* Datenbits zerlegt:

   ```
   SYNC(16) | PARITY(8) | CODEDLEN(32) | CODED bytes | ENDSYNC(16)
   ```
   Die innere, CRC-32-gesicherte Nachricht `TYPE(8) | LEN(32) | CRC32(32) |
   PAYLOAD` wird (bei PARITY>0) per Reed-Solomon kodiert und verschachtelt.
   `TYPE` = Text (0) oder Datei (1). Datei-Nutzdaten sind selbstbeschreibend:
   `nameLen(16) | name | mimeLen(16) | mime | dateiBytes`. Derselbe Bitstrom
   wird für Licht (Balken) und Audio (Töne) verwendet.
3. **Pause** (schwarz) als Trenner, danach Wiederholung.

Der Empfänger erkennt Taktflanken, tastet die Datenbalken per
Mehrheitsentscheid ab, sucht im Bitstrom das `SYNC`-Wort und akzeptiert einen
Frame nur, wenn **CRC und ENDSYNC** stimmen. Dadurch sind Falsch-Treffer
praktisch ausgeschlossen.

## Lokal ausprobieren

Wegen des Kamerazugriffs (`getUserMedia`) ist ein `https://`- oder
`http://localhost`-Kontext nötig:

```bash
python3 -m http.server 8000
# Browser: http://localhost:8000
```

Am einfachsten zum Testen: **Senden** auf dem Computer-Bildschirm öffnen,
**Empfangen** auf dem Handy – Handykamera auf die Balken halten.

## Auf GitHub Pages veröffentlichen

Zwei Möglichkeiten:

- **GitHub Actions (empfohlen):** In den Repo-Einstellungen unter
  *Settings → Pages → Build and deployment → Source* **„GitHub Actions“**
  auswählen. Der Workflow in `.github/workflows/pages.yml` deployt dann
  automatisch bei jedem Push.
- **Branch-Deploy:** *Settings → Pages → Source* = „Deploy from a branch“,
  Branch wählen, Ordner `/ (root)`.

> Hinweis: Der Kamerazugriff funktioniert nur über HTTPS – GitHub Pages liefert
> das automatisch.

## Tipps für gute Übertragung

- Niedrigeres Tempo = zuverlässiger (bei wenig Licht / langsamer Kamera).
- Alle Balken vollständig in den weißen Rahmen bringen.
- Sender-Bildschirm hell stellen und ruhig halten; Reflexionen vermeiden.
