# 🍳 LazyChef

> Das ultimative CLI-Tool für deine Koch-, Einkaufs- und Bestandsplanung.

**LazyChef** ist eine smarte Kommandozeilenanwendung, die dir hilft, deinen Küchenalltag mühelos zu organisieren. Von der Verwaltung deiner Lieblingsrezepte über das lückenlose Tracken deiner Vorräte bis hin zur KI-gestützten Auswertung deiner Kassenbelege – LazyChef nimmt dir die kognitive Last der Essensplanung komplett ab. 

Egal, ob du für dich alleine kochst, eine Großfamilie versorgst oder bestimmte Ernährungsweisen verfolgst: Plane deine Mahlzeiten, und LazyChef generiert dir vollautomatisch eine intelligente Einkaufsliste, die deinen aktuellen Vorrat zu Hause berücksichtigt.

---

## ✨ Features

### 🍲 Rezept- & Mahlzeitenplanung
- **Smarte Verwaltung:** Lege eigene Rezepte an, bearbeite sie und binde auch Fertig-/Tiefkühlgerichte in deine Planung ein.
- **Flexible Filter:** Finde sofort das passende Gericht nach Aufwand (z. B. < 30 Min.), Essgewohnheiten (Vegetarisch, Vegan) oder Personenanzahl.
- **Bedarfsgerechte Planung:** Plane flexibel (z. B. "Spaghetti Bolognese für 5 Personen") und behalte den Überblick.

### 🛒 Bestands- & Einkaufsmanagement
- **Automatische Einkaufslisten:** LazyChef gleicht deine Rezeptplanung mit deinem aktuellen Vorrat ab und setzt nur das auf die Liste, was wirklich fehlt.
- **Lückenlose Inventur:** Pflege deinen Bestand über manuelle Eingaben oder lass die KI für dich arbeiten.

### 🤖 KI-Integration (Powered by OpenAI)
- **Kassenbelege scannen:** Fotografiere deinen Kassenbon und lass LazyChef die Einkäufe automatisch deinem Bestand hinzufügen.
- **Kreative Resteverwertung:** Dir fehlen die Ideen? Lass dir von der KI spontane Rezeptvorschläge generieren, basierend auf dem, was dein aktueller Vorrat hergibt.

### 📊 Umfangreiche Analysen & Tracking
- **Dein Verhalten auf einen Blick:** Finde heraus, was deine Top 10 gekauften Lebensmittel oder am häufigsten gekochten Rezepte der Woche/des Monats sind.
- **Reichweiten-Prognose:** LazyChef sagt dir, für wie viele deiner geplanten Gerichte der Vorrat noch reicht und wann der nächste Einkauf ansteht.
- **Fertiggerichte-Quote:** Tracke den Anteil an TK-/Fertiggerichten im Vergleich zu frisch gekochten Mahlzeiten.
- **Bestandsverlauf:** Visualisiere, wie sich deine Vorräte über die Zeit entwickeln und wie häufig du einkaufen gehst.

### ⚙️ Personalisierung & Exporte
- **Individuelle Profile:** Hinterlege Intoleranzen (Laktose, Gluten etc.), Ernährungsweisen und die Standard-Personenanzahl für deinen Haushalt.
- **Exporte:** Exportiere deine Einkaufslisten und Rezepte ganz einfach als PDF oder Markdown-Datei.

---

## 🚀 Setup & Installation

LazyChef ist in JavaScript/TypeScript geschrieben und nutzt das pfeilschnelle [Bun](https://bun.sh/) als Laufzeitumgebung.

### Voraussetzungen
1. **Bun** muss auf deinem System installiert sein. ([Hier installieren](https://bun.sh/))
2. Ein **OpenAI API Key** für die KI-Features (Beleg-Scan & Rezeptvorschläge).

### Installation in 4 Schritten

1. **Repository klonen & Abhängigkeiten installieren:**
   ```bash
   git clone [https://github.com/DEIN_USERNAME/LazyChef.git](https://github.com/DEIN_USERNAME/LazyChef.git)
   cd LazyChef
   bun install
```
2. **Umgebungsvariablen konfigurieren:** Erstelle im Projekt-Root eine .env-Datei und trage deinen OpenAI-Schlüssel ein:
```bash
OPENAI_API_KEY=your_actual_api_key_here
```
3. **App starten:**
```Bash
bun run .
```
