# Norsk bokmål (`nb`): stilguide

*The style guide for the Norwegian Bokmål translation, in Norwegian since it is
written for the next person who translates Cellarion into Bokmål. How the
translation was done is in [how-bokmal-was-translated.md](./how-bokmal-was-translated.md).*

Denne fila er for deg som oversetter Cellarion til bokmål i Weblate. Den har
stilreglene, reglene som kom til underveis og valgene som er tatt, med
alternativene som ble forkastet. Den er laget så du slipper å ta de samme
diskusjonene på nytt.

**Termene står ikke her.** Ordlisten (kjeller, reol, drikkevindu, vindagbok og
resten) ligger i Weblate-ordlisten for bokmål i
[Cellarion-prosjektet](https://hosted.weblate.org/projects/cellarion/), der den
vises ved siden av hver streng. Hold den oppdatert der, så det bare finnes én
liste.

Grunnlaget er den engelske kildefila, den svenske oversettelsen som
sammenligning, [TRANSLATING.md](../../TRANSLATING.md) og
[Språkrådets](https://www.sprakradet.no/) normer og klarspråksråd. Vinord følger
[Vinmonopolets](https://www.vinmonopolet.no/) ordbruk der det finnes et etablert
ord.

## Stilguide

Tonen er uformell, direkte og presis. Skriv som en vinvenn som kan appen, ikke
som et forsikringsselskap.

| Regel | Skriv | Ikke |
| --- | --- | --- |
| Du-form, alltid liten d | Du har 12 flasker | Du har / De har |
| Eiendomsord etter substantivet | kjelleren din, flaskene dine | din kjeller, dine flasker |
| Stor bokstav bare i første ord | Legg til flaske | Legg Til Flaske |
| Ingen «vennligst» | Fyll ut navn | Vennligst fyll ut navn |
| Imperativ på knapper | Lagre, Slett, Legg til | Lagring, Sletting |
| Sammensatte ord i ett | vinkjeller, smaksnotat | vin kjeller, smaks notat |
| Anførselstegn | «{{name}}» er slettet | “{{name}}” er slettet |
| Tall og prosent | 1 250 kr, 3,5 %, 62 % | 1,250 kr, 3.5% |
| Dato | 24. oktober 2026 | 10/24/2026 |
| Forkortelser | f.eks., osv., ev. | e.g., etc., evt. |
| Ellipse og lasting | Lagrer … / Laster inn … | Lagrer..., Lagring pågår |

**Plassholdere og flertall**

- `{{count}}`, `{{name}}`, `{{year}}` og lignende står urørt. Det samme gjelder
  formattillegg som `{{count, number}}`.
- Bokmål har to flertallsformer: `_one` og `_other`. `_one` kan droppe tallet når
  det leser bedre: «én flaske».
- Sjekk at setningen fortsatt er grammatisk når plassholderen er byttet ut med et
  navn eller tall.

**Tegnsetting**

- Ikke komma foran «og» i oppramsinger. Komma etter en leddsetning som står
  først: «Når du har drukket flasken, kan du skrive et smaksnotat.»
- Ingen em-strek (—). Der engelsken bruker den, skriv to setninger, bruk kolon
  eller komma.
- Piler i kildeteksten (→, ←) beholdes slik de står.

**Lengde**

Norsk blir ofte 10–20 % lengre enn engelsk. På knapper og faner velger du det
korteste naturlige ordet, og sjekker i appen at teksten ikke blir kuttet. Bruk
forhåndsvisningen: `https://cellarion.app/?lng=nb`.

**Ikke oversett**

Cellarion, CellarTracker, Vivino, Vinmonopolet, Systembolaget, tekniske koder
(R3C2), e-postadresser i demodata.

## Regler fra oversettelsen

Regler som kom til mens appen ble oversatt, samlet etter tema.

**Tone og ordvalg**

- Stryk «please». Fjern utropstegn nesten overalt: Kopiert, ikke Kopiert!
- Feilmeldinger følger «Kunne ikke + verb» eller «Noe gikk galt».
- Konservative former overalt: lignende, sammenligne, uken, filen, listen.
- «Virker» i korte statusmeldinger, «fungerer» i forklaringer.
- Interne statuser som «active» oversettes ikke ordrett. Skriv det brukeren ser:
  Sett den tilbake i kjelleren.
- Plassholdertekst i felt oppfordrer i stedet for å spørre på engelsk vis:
  Hvordan var vinen? Skriv gjerne et smaksnotat. Ikke «Noen smaksnotater?».
- Unngå to «til» i samme setning. «More» blir ny eller nye når verbet er «legge
  til»: Én ny flaske er lagt til i kjelleren. Ikke «Én flaske til er lagt til».
- Ta med preposisjonen der engelsken dropper den: Bestilt, ventet i {{month}}.
  Ikke «ventet {{month}}». Sjekk i appen at plassholderen blir et månedsnavn.
- Noe som er over, er passert: Sen: har passert toppen. Ikke «etter toppen».
- «Trykk på» overalt, også der det fungerer med mus. Unntak: «Shift+klikk» og
  3D-rommet, som bare brukes med mus, og det faste uttrykket «med ett klikk».
- Om «Nylig slettet»: «Gjenopprett» på knapper og i meldingene som hører til dem,
  «hente tilbake» i forklaringer. Å gjenopprette en sikkerhetskopi eller en import
  er noe annet og beholder «gjenopprette».
- Lister over tilganger bruker verb i infinitiv: Se, Merke, Legge til.

**Tall og tegn**

- Em-streker blir punktum, komma eller kolon. Etter kolon kommer liten
  bokstav.
- Tall til og med tolv skrives med bokstaver i løpende tekst: innen to dager.
  Tellere, merkelapper og korte metadata som settes sammen av flere strenger,
  beholder sifrene: «1 flaske, høyeste hylle 3».
- Lister av tall i eksempler får mellomrom etter kommaet, så de ikke leses som
  desimaltall: f.eks. 1, 3. Ikke «1,3».
- Plassholdertekst for e-post er navn@example.com, fordi domenet er reservert.

**Flertall**

- `_one` bruker «Én» i hele setninger (Én enhet er registrert), men tallet i
  korte tellere og merkelapper (1 flaske valgt).
- En streng med `{{count}}` uten flertallsform skrives slik at tallet ikke må
  bøyes: Viner kopiert fra registeret: {{count}}.

**Knapper, menyer og navn**

- Menypunkter, sidetitler og faner bruker «Mine …» foran: Mine kjellere, Mine
  forslag, Mine utkast, Mine henvendelser. Sidetittelen kan legge til «vin», som
  engelsken: Mine vinforslag. I løpende tekst står eiendomsordet etter:
  kjelleren din, flaskene dine.
- Knapper som går til kjellerne, sier «Gå til kjellerne mine». Menyen og
  sidetittelen heter «Mine kjellere».
- Norske knappenavn i løpende tekst står i «»: Trykk på «Rett» eller «Legg til».
  Engelske menynavn står uten, fordi de skiller seg ut av seg selv.
- Menynavn i Claude og ChatGPT står på engelsk: Customize → Connectors.
- Navn på tabeller, felt, filer og menyvalg i andre apper (CellarTracker, Vivino,
  Ploc) står på engelsk uten «», slik brukeren ser dem der. I etiketter står bare
  navnet: «Gjenkjent format: CellarTracker · List». Kolonnenavn som importen
  krever (Currency, Wine, Producer, Vintage), står også på engelsk.
- Eksempler på navn brukeren skriver inn, får stor forbokstav i hvert navn:
  f.eks. Kjeller, Kjøleskap på kjøkkenet.
- Ordet i `<strong>` i `settings.danger.typeToConfirm` leses av koden, så det
  oversettes: Skriv SLETT for å bekrefte. Appen godtar også DELETE.

**Markedsføring**

- Det står at alle funksjoner er gratis, ikke «hovedfunksjonene». Forsiden
  forklarer det brukeren merker, ikke det som skjer bak (ikke «fjerner
  duplikater»).

## Avgjorte valg

Valgene ble tatt 24. oktober 2026 og gjelder alle strenger. Det forkastede
alternativet står med, så spørsmålet ikke tas opp igjen ved et uhell.

| Engelsk | Valgt | Forkastet |
| --- | --- | --- |
| cellar | kjeller (vinkjeller i intro og hjelp) | vinkjeller overalt |
| rack | reol | vinstativ, stativ |
| journal | vindagbok | dagbok, vinjournal |
| rating | vurdering | karakter, poeng |
| peak | på topp på merkelapper, på sitt beste i hele setninger | toppmoden |
| at most | maks | høyst |
| restock | påfyll | innkjøp |
| cellar chat | kjellerchat | |
| support | brukerstøtte | support |
| support tickets | henvendelser | saker |
| AI | KI (KI-kobling, KI-budsjett) | AI |
| wine report / report wine | feilrapport / meld feil | rapporterte viner, rapporter vin |
| open an issue on GitHub | meld fra på GitHub | opprett en sak, issue |
| reset link (knapp) | Send lenke for nytt passord | Send lenke, tilbakestillingslenke |
| An error occurred | Noe gikk galt | Det oppstod en feil |
| Likestilte former | konservative: frem, senere, mellom | fram, seinere |

Alle funksjoner i Cellarion er gratis. En «plan» er bare et frivillig
støttenivå, så plan og tier blir støttenivå: Støttenivåer i menyen,
Støttenivået ditt i innstillingene og Sammenlign støttenivåer →.
«Abonnement» brukes bare om Claudes egne betalte planer.
