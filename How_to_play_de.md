# Primordium — Anleitung

Primordium ist eine künstliche Chemie: eine 2D-Welt voller Tausender
Atome, die in Brownscher Bewegung umherdriften. Jedes Atom hat einen
**Typ** (`a`–`f`, `w`, `p`), einen numerischen **Zustand** und kann
**Bindungen** mit Nachbarn eingehen. Wann immer Atome aufeinandertreffen,
feuert eine kleine Tabelle von Reaktionsregeln: Jede Regel prüft Muster
aus Typen, Zuständen und bestehenden Bindungen der Atome und kippt dann
Zustände oder knüpft bzw. löst Bindungen — manchmal nur mit einer
Wahrscheinlichkeit.

Das ist die gesamte Physik. Das Besondere ist, was diese Chemie
*hervorbringt*:

- **Membranen emergieren.** `a`-Atome polymerisieren zu Ketten; schließt
  sich eine Kette zu einem Ring, wird daraus ein physischer Behälter —
  die Membranelastik wirft Atome ab, wenn sie zusammenknittert, und
  nimmt freie Soup-Atome auf, wenn sie gestreckt wird.
- **Gene sind Materie.** Ein Genom ist wörtlich ein Strang verbundener
  Atome (`e-b-b-a-c-b-d-f`), der an der Membran verankert ist. Ein
  freies `d`-Atom wirkt als Polymerase: Es landet am Stranganfang (`e`),
  wandert die Matrize Base für Base ab und baut eine Kopie — Replikation
  ist mechanisch, kein gescripteter „reproduce“-Aufruf.
- **Zellen teilen sich.** Erreicht die Polymerase das Strangende (`f`),
  spaltet eine Reaktionskaskade die Zelle in zwei Töchter. Der ganze
  Lebenszyklus — Membranwachstum, Genomkopie, Teilung — ergibt sich aus
  wenigen Dutzend lokalen Reaktionsregeln.
- **Evolution ist real.** Noise-Regler streuen Kopiermisfires, Zerfall
  und Bindungsfehler ein; mutierte Stränge erzeugen andere Zellen, und
  Zellen konkurrieren um Soup-Atome. Dokumentierte Emergenz geht schon
  über die publizierte Forschung hinaus — siehe die spontan entstandene
  Meta-Membran, die ganze Zellcluster umschließt, in `samples/`.
- **Nichts ist als „Zelle“ hartkodiert.** Es gibt kein Zell-Objekt in
  der Engine — eine Zelle ist ein selbsterhaltendes Muster im
  Bindungsgraphen. Du kannst zusehen, wie eine geboren wird, ihr Genom
  kopiert, sich teilt, verhungert, von einem Räuber gefressen oder von
  Lysin aufgelöst wird.

Die Simulation ist zugleich ein Forschungsinstrument: Pausiere an
beliebiger Stelle, inspiziere jede Struktur Atom für Atom, schreibe die
Chemie live im Lab um und exportiere exakte, bitidentische
Speicherstände.

Diese Anleitung spiegelt die In-App-Doku (Steuerungs-Panel,
Shortcuts-Karte, Atom-Wörterbuch).

## Erste Schritte

1. Projekt bauen und über HTTP ausliefern (Worker brauchen einen
   Origin): `bash run.sh` baut und serviert; für die manuelle Variante
   einmal `npm run build` ausführen, dann `python3 -m http.server 9131`
   und `http://localhost:9131/` öffnen.
2. Die Sim startet mit einer geseedeten Soup. Beobachte, wie Protozellen
   von selbst entstehen — oder öffne das **Controls**-Panel (`M` /
   ☰-Button), um einzugreifen.
3. Zum ersten Mal hier? Klicke den **?**-Button (oben rechts) oder
   **🎓 Tutorial** im Panel — eine geführte Tour mit echten Aufgaben auf
   dem Spielfeld: Sie geht erst weiter, wenn du die Sim pausiert, Atome
   selektiert, den Inspektor geöffnet, Soup und Wasser gemalt, Lysin
   freigesetzt und den Spielmodus gestartet hast. Mittendrin fügt ein
   Skript eine echte Protozelle ein — und die Tour endet mitten im
   Spiel, du kannst direkt weitersteuern.

### Die Anleitung im Spiel

Dieselbe Dokumentation ist direkt in der App eingebaut:

- `M` (oder der ☰-Button) öffnet das **Controls**-Panel: jede
  Sektions-Karte enthält Inline-Hinweise, und die **Shortcuts**-Karte
  listet alle Tastenkürzel.
- Der Button **⚗️ Custom chemistry editor** (Lab-Sektion des Panels)
  öffnet das Lab; der Tab **📖 Dictionary** erklärt dort jedes Atom in
  einfachem Englisch — eigene Custom-Atoms eingeschlossen.

### Die Physik lernen

Neu bei künstlichen Chemien? [Organic Builder](https://github.com/rubo77/OrganicBuilder)
ist ein kostenloses Schritt-für-Schritt-Tutorial, das genau dieses
Atom/Zustand/Bindungs-Reaktionsmodell über kleine spielbare Challenges
beibringt — der schnellste Weg zu verstehen, was in Primordiums Soup
passiert.

## Ansichten

`V` schaltet drei Render-Modi durch:

- **Educational** — Legende + Bonds + Bézier-Membranen (Standard)
- **Microscope** — mikroskopisch gestylte Darstellung
- **Classic** — klassischer Squirm3-Look

## Steuerungs-Panel

### View · Playback
- **Pause** (`Space`) — Sim pausieren/fortsetzen
- **View** (`V`) — Render-Modus wechseln
- **● REC** (`R`) — Canvas als Video aufzeichnen

### Brushes · Tools
- **Soup brush** (`B`) — freie Soup-Atome in die Welt malen
- **Water brush** (`W`) — Wassertröpfchen malen
- **Clear water** (`C`) — alles Wasser entfernen
- **Select atom** — Atom anklicken zum Auswählen; `Entf` löscht es
- **Lysin** (`P`) — Lysin setzen/entfernen; Membranen lösen sich bei
  Kontakt auf

### World · Replenishment
- **Drip** — periodische Nachlieferung; Regler setzen Intervalle in
  Ticks (Soup 100–3000, Standard 700 · Wasser 500–15000, Standard 4250)
- **Seed** — PRNG neu seeden und neu starten

### Physics
- **speed** — Simulationsrate (5–100 %, Standard 100 %); kleinere
  Werte strecken die Schritte zu flüssiger Zeitlupe
- **soup** — Soup-Dichte (0–100 %, Standard 60)
- **damp** — Dämpfung gebundener Atome (0,50–1,00)

### Lab
- **Noise** (`N`) — mutagene Rausch-Regler: `copy` (Kopiermisfires),
  `decay` (Zufallszerfall), `bond` (Bindungsfehler), jeweils 0–1000
- **Hydrolysis** (`H`) — wassergetriebene Bindungsspaltung; `rate`-
  Multiplikator und `density`-Schwelle
- **Open inspector** (`I`) — eingefrorene Ansicht der aktuellen Auswahl
- **Paste from JSON** — gespeicherte Auswahl in der Ansichtsmitte
  ablegen
- **Custom chemistry editor** — eigene Atome und Regeln definieren

### Archive · Export
- **Save / Load** — kompletter Sim-Zustand als JSON (Atome, Bindungen,
  Tröpfchen, RNG-Zustand, Parameter — Laden ist bitidentisch, inklusive
  PRNG-Cursor)
- **Reset simulation** — zurücksetzen und neu starten
- **stats CSV** — Populations-/Loop-Statistik-Log, exportierbar
- **events CSV** — Ereignis-Log (Noise-Misfires, Bindungsfehler, …)

## Spielmodus — ein Mikrobe steuern

`G` schaltet den Spielmodus um: Du steuerst eine grüne Mikrobe.

- **Auf das Spielfeld drücken und halten** steuert die Mikrobe zur
  Maus- oder Fingerposition
- **WASD** bietet dieselbe Steuerung als Desktop-Alternative — ein
  Schubs, kein Antrieb
- Periodische **Soup-/Wasser-Spawns** halten dich bei Kräften;
  **Lysin-Mikro-Spots** erscheinen ca. alle 10.000 Ticks und lösen
  Membranen bei Kontakt auf
- Ein Membranring gilt als **deiner**, wenn ≥ 40 % seiner Atome
  spielergesteuert sind
- **Sieg** 🏆 — keine *vollständig lebende* feindliche Zelle
  (geschlossene Membran mit beiden verankerten Gen-Enden) überlebt
  ~5 Sekunden
- **Niederlage** ☠ — alle deine Zellen wurden lysiert

## Atom-Wörterbuch

Eingebaute Atome (`a`–`f`, `w`, `p`) — die Wildcards `x`/`y`/`z` sind
für den Regelabgleich reserviert:

| Atom | Rolle |
|------|-------|
| `a` | **Membranbaustein** — Strukturelement der Zellwände. Ein geschlossener Ring aus `a`-Atomen *ist* die Membran. Lysin (`p`) und Wasser brechen `a`-`a`-Bindungen. In Zustand 38 fungiert es als Gen-Base. Analogie: Peptidoglycan. |
| `b` | **Häufige Gen-Base** — häufigste Base im Genomstrang (Matrize `e-b-b-a-c-b-d-f`). Die Polymerase läuft daran vorbei. Analogie: Adenin/Thymin. |
| `c` | **Seltene Gen-Base** — kommt einmal im Standard-Template vor; chemisch identisch mit `b`, nur seltener. Analogie: Cytosin/Guanin. |
| `d` | **Polymerase-Enzym** — wandert einen Genstrang ab (Zustand 41) und kopiert ihn Base für Base; löst sich bei `f`. `d` ist Enzym *und* ein Baustein des Gens, das es selbst codiert — wie echte DNA-Polymerase. |
| `e` | **Gen-Start** — markiert ein Strangende, an einem T-getaggten Membranatom verankert (Chromosom an der Wand festgemacht, wie oriC). Die Replikation beginnt hier. |
| `f` | **Gen-Ende** — markiert das andere Ende, gegenüber verankert. Erreicht die Polymerase `f`, löst sie den Strang und die Teilung in zwei Tochterzellen aus. Analogie: ter-Site + FtsZ-Divisom. |
| `w` | **Wasser** — Tröpfchen, von Oberflächenspannung zusammengehalten. Frisches Wasser (Zustand 0) kann pro Tick eine ungeschützte Bindung spalten, danach ist es verbraucht (Zustand 1). Massenerhaltend; Membranen lebender Zellen sind immun. |
| `p` | **Lysin** — Katalysator, der frei `a`-`a`-Membranbindungen spaltet; wird nie verbraucht. Nur *ungebunden* aktiv — forciert gebundenes Lysin ist inert. Analogie: Lysozym / Phagen-Endolysin. |

## Auswahl-Inspektor

Atom auswählen (`Select atom`-Pinsel), dann mit `I` öffnen:

- Schreibgeschützte eingefrorene Ansicht mit Statistiken; die Sim läuft
  darunter weiter
- **Edit**-Modus — Werkzeuge zum `＋ Add`, `⎯ Bond`, `✕ Delete` von
  Atomen mit Typ-Palette und Zustandseingabe; Edits wirken auf die
  laufende Sim
- **Replace** — jedes Atom eines Quelltyps in der gesamten Sim ersetzen
- **Download / Load JSON** — Auswahlen speichern, in späteren Runs
  laden, per `📥 Paste` einfügen (wird in der Ansichtsmitte abgelegt,
  Bindungen bleiben erhalten)

## Custom-Chemistry-Editor (⚗️ Lab)

- **Custom Atoms** — `a`–`f`, `w`, `p`, `x`–`z` sind reserviert; neue
  Atome bekommen einen Großbuchstaben oder eine Ziffer. Ohne Regeln
  sind sie inert.
- **Custom Rules** — feuern *nach* der eingebauten Chemie; sie können
  die geseedeten Reaktionen niemals überschreiben oder entfernen.
  2- oder 3-Eingangs-Reaktanten; `Cases` ist der
  Wahrscheinlichkeits-Nenner (1 = immer, 100 ≈ 1 % pro Begegnung).
  Regeln können Zustände kippen und Bindungen knüpfen/lösen.
- **Dictionary-Tab** — jedes Atom in einfachem Englisch erklärt;
  Custom Atoms bekommen automatisch generierte Beschreibungen aus
  deinen Regeln.

## Tastenkürzel

| Taste | Aktion |
|-------|--------|
| `M` | Steuerungs-Panel öffnen/schließen |
| `Space` | pausieren/fortsetzen |
| `V` | Ansicht wechseln (Educational → Microscope → Classic) |
| `B` | Soup-Pinsel |
| `W` | Wasser-Pinsel |
| `C` | alles Wasser entfernen |
| `P` | Lysin an/aus |
| `R` | Video aufzeichnen |
| `G` | Spielmodus (Mikrobe steuern) |
| `N` | Noise an/aus |
| `H` | Hydrolyse an/aus |
| `,` | Schnellspeichern |
| `.` | Schnellladen |
| `Q` | Einfrieren (Pause + Noise auf 0 + Schnellspeichern) |
| `Entf` | ausgewähltes Atom löschen (im Select-Modus) |
| `Esc` | Panel schließen / zurück zum Pannen |
| Ziehen | Kamera pannen |
| Rad | Zoom unter dem Cursor |
| 2 Finger | Pinch-Zoom (Touch) |

## Persistenz

- **Autosave** — periodische Snapshots in `localStorage`; ein
  geschlossener Tab kehrt zu fast demselben Zustand zurück (bei Pause
  übersprungen)
- **Speicherstände** — kompletter Sim-Zustand als JSON; Laden erzeugt
  aus dem gespeicherten PRNG-Cursor eine bitidentische Entwicklung
- **Samples** — `samples/` enthält eine dokumentierte
  Meta-Membran-Entstehungssequenz (siehe `samples/README.md`)
