# Flight Engine Firebase

Applicazione React + Firebase per monitorare automaticamente i prezzi dei voli.

## Layout mobile

Il layout desktop mantiene le tabelle e la disposizione esistente. Su telefoni il viewport usa la larghezza reale dello schermo, i risultati diventano schede con etichette, i moduli usano una colonna e lo storico prezzi si apre a schermo intero. La navigazione resta visibile durante lo scorrimento; campi e pulsanti hanno dimensioni adatte al tocco. Il grafico si può scorrere orizzontalmente senza allargare la pagina. Le regole dedicate sono in `web/src/mobile.css`, attive fino a 767 px e fino a 960 px sui dispositivi con puntatore touch, per coprire anche l'orientamento orizzontale.

## Parametri modificabili dalla dashboard

- ricerche, date, aeroporti, notti, viaggiatori, scali e soglia A/R per persona;
- autocomplete per città/codici IATA e itinerari Open jaw con aeroporti di ritorno differenti;
- il suggerimento aeroporti consulta l'API autenticata `searchAirportCatalog`, basata sul catalogo pubblico mondiale [OurAirports](https://ourairports.com/data/), senza nuove chiavi API. Il backend aggiorna la cache ogni 24 ore quando utilizzato; i suggerimenti locali restano disponibili se la fonte non risponde. I nomi internazionali, le città e i codici IATA sono ricercabili. Tenerife include TFS e TFN;
- selezionando una città vengono cercati tutti gli aeroporti associati (per esempio Milano = MXP, LIN e BGY); selezionando un codice viene cercato solo quell'aeroporto;
- importazione JSON/CSV, scelta del formato CSV o JSON in esportazione, modifica e duplicazione delle ricerche;
- avvio manuale, consultazione degli ultimi risultati e storico delle esecuzioni;
- mesi di anticipo, numero risultati, batch, percentuale minima di calo;
- valuta, destinatario email e provider abilitati.

Le chiavi API e la password applicativa Gmail sono secret backend e non vengono mai salvate nel browser o in Firestore.

## Configurazione

1. Creare un nuovo progetto Firebase e attivare Authentication email/password, Firestore, Functions e Hosting.
2. Copiare `.firebaserc.example` in `.firebaserc` e inserire il project ID.
3. Copiare `web/.env.example` in `web/.env` e valorizzare la configurazione web Firebase.
4. Installare Firebase CLI e dipendenze: `npm install`.
5. Configurare i secret come array JSON e credenziali Gmail:
   - `firebase functions:secrets:set SERPAPI_KEYS`
   - `firebase functions:secrets:set RAPIDAPI_KEYS`
   - `firebase functions:secrets:set EMAIL_USER`
   - `firebase functions:secrets:set EMAIL_APP_PASSWORD`
6. Creare almeno un utente dalla console Firebase Authentication.
7. Eseguire `npm run build`, poi `firebase deploy`.
8. Configurare lo scheduler Google Apps Script seguendo [`apps-script/README.md`](apps-script/README.md).

Il deploy compila automaticamente Functions e Hosting prima di pubblicarli e si interrompe se la compilazione fallisce. Per pubblicare le correzioni e il log dettagliato eseguire dalla radice del progetto:

```sh
firebase deploy --only functions,hosting,firestore:indexes
```

Se un log esportato contiene `apiCalls` ma non `logVersion` e ha `entries: []`, quella esecuzione proviene dal backend precedente. I dettagli di quelle chiamate non sono stati salvati: dopo il deploy avviare una nuova esecuzione. Il codice backend pubblicato è `functions/lib/index.js`, generato da `functions/src` durante la compilazione.

## Note

- Le chiavi vengono usate in ordine, prima SerpApi e poi RapidAPI. Ogni esecuzione condivide fra sotto-task e retry lo stato `execution_logs/{runId}/state/api_keys`. Parte dalla prima chiave precedentemente disponibile, percorre la lista e puo tornare alle chiavi iniziali una sola volta: una chiave che risponde HTTP 429 resta esclusa per tutta l'esecuzione. Esaurito il giro, nessuna data, aeroporto o sotto-task puo azzerare lo stato e ricominciare. Un nuovo avvio esplicito o schedulato (Apps Script, stessi id delle chiavi) permette un nuovo giro, per verificare eventuali quote ripristinate. Lo stato globale `engine_state/api_keys` conserva soltanto impronte delle chiavi come punto di ripartenza. Le chiamate gia in corso su altri worker possono terminare dopo il primo 429. Risultati vuoti ed errori diversi dal limite non cambiano chiave.

- In Storico, **Mostra log** elenca in tempo reale preparazione delle ricerche e ogni tentativo API, con URL, parametri, header, stato HTTP, durata ed esito. **Mostra risposta completa** carica il corpo ricevuto, anche per errori HTTP o risposte non JSON. **Scarica log completo** esporta esecuzione, eventi e risposte in JSON. Le credenziali vengono oscurate; i corpi grandi sono suddivisi in documenti senza troncamento.
- Il dettaglio è disponibile per le nuove esecuzioni dopo il deploy di Functions e Hosting. Pubblicare anche gli indici Firestore aggiornati, che escludono dall'indicizzazione i corpi delle risposte. Le esecuzioni precedenti non contengono questi dati.

- Nome destinazione e Cluster sono facoltativi; se manca il nome viene usata la destinazione. Avvia ora esegue il modulo compilato senza creare o modificare una configurazione salvata. Con modulo vuoto esegue tutte le ricerche attive salvate. Aggiungi ricerca e Salva modifiche sono le azioni di salvataggio.
- Le ricerche sono raggruppate per Cluster e Partenza dal. I vecchi valori di Periodo / note sono trattati come Cluster. Le date nell'interfaccia, nelle esportazioni e nelle email sono in formato GG/MM/AAAA; internamente e nelle richieste ai provider sono ISO.
- Risultati mostra una riga per ricerca: la migliore offerta dell'ultima esecuzione con risultati. Il clic sulla ricerca o sul risultato apre ultimo prezzo, andamento delle ultime 20 esecuzioni con offerte e tabella dello storico. Andata e ritorno riportano i codici degli aeroporti; Provider riporta soltanto il servizio.
- Le email raggruppano per Cluster e riportano destinazione, date, aeroporti, compagnie, orari, durata del volo, scali, durata degli scali, totale e totale per persona. Un errore email viene segnalato nello storico senza perdere i risultati della ricerca.
- Per ogni data e coppia di aeroporti, una ricerca A/R standard effettua una sola chiamata con entrambe le date: SerpApi usa `type=1`, RapidAPI `return_date`. Non seguono richieste di dettagli o token. Il totale e il prezzo per persona provengono esclusivamente da questa risposta; i prezzi separati delle tratte restano `null`.
- Quando il ritorno parte da un aeroporto diverso dall'arrivo dell'andata o arriva in un aeroporto diverso dalla partenza iniziale, si cercano due voli one-way. Ogni richiesta contiene solo la data della propria tratta (SerpApi `type=2`, RapidAPI senza `return_date`). Il totale e la somma dei due prezzi one-way; non si usano API multi-city. Le tratte identiche sono riutilizzate fra combinazioni della stessa ricerca, anche quando non hanno risultati. La chiave della cache distingue una tariffa A/R da una tariffa one-way.
- `topResults` limita i risultati salvati senza aggiungere chiamate. Le offerte standard hanno `returnDetailsStatus=NOT_REQUESTED`: interfaccia ed email indicano che il ritorno e incluso nel prezzo A/R, con dettagli non richiesti, senza generare un WARNING. Gli itinerari composti da due one-way hanno `priceType=SEPARATE_ONE_WAY`, prezzi e dettagli di entrambe le tratte; vengono salvati solo se entrambe sono disponibili.
- Il log include date, combinazioni di aeroporti, chiamate A/R e chiamate one-way previste, con zero chiamate per dettagli aggiuntivi. Le date rispettano l'intervallo inclusivo, escludono il passato e sono limitate dai mesi di anticipo. WEEKEND mantiene la convenzione giovedi-venerdi-sabato. Esempio Cairo marzo-aprile 2027: 26 date x 3 aeroporti di Milano = 78 chiamate, indipendentemente da `topResults`; una singola data e coppia di aeroporti richiede una chiamata A/R oppure due one-way per un open jaw. I tentativi su chiavi sature si aggiungono al conteggio fino all'arresto del giro.
- `npm test` compila il backend ed esegue i test di regressione del parsing e del filtro scali, poi i test dello script Apps Script (parità con il backend TypeScript e flusso completo su Firestore simulato). `npm run build` compila anche l'interfaccia.

- **Ricerche schedulate: Google Apps Script.** Lo scheduler non è più una Cloud Function. Lo script in `apps-script/` (legato al foglio "2026_11_Monitoraggio Voli", usato solo come contenitore) ogni 5 minuti legge `settings/global`, avvia le ricerche attive allo slot configurato (ora, minuti, giorni, fuso) e scrive risultati, stato e diagnostica negli stessi documenti Firestore (`execution_logs`, `flight_results`, `flight_searches`). La deduplica usa sempre `lastScheduleSlot`; stato dello scheduler e prossima esecuzione sono in `engine_state/scheduler` e visibili in Impostazioni. Le esecuzioni lunghe procedono a blocchi di circa 4 minuti e riprendono al trigger successivo. Setup in [`apps-script/README.md`](apps-script/README.md).
- **Ricerche puntuali (Avvia ora): invariate.** Passano da `runFlightSearchNow` e dalla coda Cloud Tasks: ogni avvio crea una sessione principale e una sotto-sessione per ciascuna ricerca. La coda esegue al massimo tre ricerche contemporaneamente, salva ogni riga in modo indipendente e ritenta fino a tre volte i sotto-task falliti. Lo Storico mostra quante righe sono in attesa, in corso, concluse o fallite e permette di aprire il dettaglio dei sotto-task.
- Il deploy delle Functions crea anche la coda `processFlightSearchTask`. Nel progetto Google Cloud devono essere abilitate Cloud Tasks API e le autorizzazioni richieste dal deploy Firebase.
- Il CSV supporta intestazioni con i nomi dei campi oppure il formato senza intestazioni del file import.csv: origin;destination;returnOrigin;returnDestination;departureFrom;departureTo;pricePerPerson;maxStops;nights;destinationName;travelers;allowedDays;cluster. Un'eventuale quattordicesima colonna indica active. Sono supportati campi tra virgolette e date italiane o ISO. Il file viene validato interamente prima del salvataggio; un errore indica la riga da correggere.
- Il campo soglia rappresenta il prezzo massimo A/R per singolo viaggiatore.
- Prima del deploy rigenerare le API key che erano presenti nel vecchio sorgente.
- Le regole incluse consentono l'accesso a qualunque utente autenticato. Per più utenti vanno rese owner-based.
