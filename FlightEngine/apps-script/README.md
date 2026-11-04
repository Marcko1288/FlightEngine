# Flight Engine: scheduler Google Apps Script

Questo script esegue le **ricerche schedulate** al posto della vecchia Cloud Function `nightlyFlightSearch`.
Le ricerche puntuali (pulsante "Avvia ora" della webapp) restano su Firebase e non cambiano.

```
Trigger ogni 5 min ─► runScheduler()  (LockService: un solo passaggio alla volta)
      │
      ├─ esecuzione in corso? ─► riprende dal punto salvato (blocchi di ~4 min)
      └─ slot dovuto (settings/global)? ─► rivendica lastScheduleSlot ─► crea execution_logs/{runId}
                                            ─► SerpApi / RapidAPI (UrlFetchApp) ─► flight_results, flight_searches
                                            ─► email di alert (MailApp) a fine esecuzione
```

Lo script è **legato al foglio "2026_11_Monitoraggio Voli"**, che fa solo da contenitore: lo script non legge
né scrive celle. Tutti i dati restano in Firestore e la webapp li mostra come prima.

## Cosa fa, in breve

| Aspetto | Comportamento |
|---|---|
| Configurazione | Stessa di oggi: `settings/global` (`scheduleEnabled`, `scheduleHour`, `scheduleMinute`, `scheduleDays`, `scheduleTimezone`), ricerche `flight_searches` con `active == true`. |
| Slot dovuto | Ultimo orario configurato negli ultimi 60 minuti; deduplica in transazione su `settings/global.lastScheduleSlot` (stesso formato del vecchio scheduler, quindi niente doppi avvii neppure durante la migrazione). |
| Dati scritti | Gli stessi documenti del backend Firebase: `execution_logs/{runId}` (+ `tasks`, `entries`, `state/api_keys`), `flight_results`, `flight_searches.lastCheckAt/lastStatus/lastPrice`, `engine_state/api_keys`. Le run hanno in più `executor: "APPS_SCRIPT"`, `trigger`, `scheduleSlot`, `nextResumeAt`. |
| Logica | Date, combinazioni A/R e open jaw, chiamate provider, parsing, filtro scali, top N, alert (soglia o calo %) portati 1:1 da `functions/src`; i test in `test/` lo verificano confrontando i due codici. |
| 6 minuti | Budget di 4 minuti per blocco. Lo stato di ripresa (piano, cursore, offerte trattenute, risposte già ottenute per tratta) è salvato in `execution_logs/{runId}/tasks/{id}/progress` e `.../legs`: alla ripresa nessuna chiamata viene ripetuta. |
| HTTP 429 | La chiave viene esclusa per tutta l'esecuzione (anche in `engine_state/api_keys`), pausa breve (`Retry-After`, max 2 s) e passaggio alla chiave successiva. Esaurito il giro di chiavi l'esecuzione si ferma: nessun loop. |
| 5xx / rete | Al massimo 2 nuovi tentativi, con backoff 1 s e 3 s; ogni tentativo è registrato nel log. |
| Errori interni | Il sotto-task viene ritentato nei blocchi successivi, al massimo 3 tentativi in totale (come Cloud Tasks). |
| Sicurezza | Tetto di chiamate per esecuzione (`MAX_CALLS_PER_RUN`, default 3000). |
| Arresto | Il pulsante "Arresta esecuzione" della webapp funziona: lo script lo applica fra una chiamata e l'altra o al blocco successivo. |
| Stato scheduler | `engine_state/scheduler` (ultimo controllo, esito, prossima esecuzione, esecuzione attiva), mostrato in Impostazioni. |

## 1. Service account Firebase

1. Console Google Cloud del progetto Firebase → **IAM e amministrazione → Account di servizio** → *Crea account di servizio*, ad esempio `flight-engine-apps-script`.
2. Ruolo: **Cloud Datastore User** (`roles/datastore.user`). Basta questo: permette lettura e scrittura di Firestore e nient'altro.
3. Nella scheda **Chiavi** dell'account → *Aggiungi chiave → Crea nuova chiave → JSON*. Conserva il file: serve al punto 3 e poi va eliminato dal computer.

Le regole di sicurezza Firestore (`firestore.rules`) **non vanno modificate**: le richieste autenticate con un service account IAM non passano dalle regole, che continuano a valere per gli utenti della webapp.

## 2. Creare lo script nel foglio

**Da browser (senza strumenti)**
1. Apri il Google Sheet **"2026_11_Monitoraggio Voli"** → *Estensioni → Apps Script*.
2. In *Impostazioni progetto* attiva **"Mostra il file manifest appsscript.json"** e incolla il contenuto di `apps-script/appsscript.json`.
3. Crea un file per ogni file in `apps-script/src/` con lo stesso nome (es. `00_Config`) e incolla il contenuto. L'ordine dei file non conta.

**Con clasp (consigliato per gli aggiornamenti)**
```bash
npm install -g @google/clasp
```
```bash
clasp login
```
Crea prima lo script dal foglio (passo 1 qui sopra), poi copia lo *Script ID* da *Impostazioni progetto*:
```bash
cd apps-script && cp .clasp.json.example .clasp.json
```
Inserisci lo Script ID in `.clasp.json`, poi:
```bash
clasp push
```
`.claspignore` pubblica solo `appsscript.json` e `src/*.js` (i test restano fuori).

## 3. Script Properties

Editor Apps Script → *Impostazioni progetto → Proprietà script*:

| Proprietà | Obbligatoria | Valore |
|---|---|---|
| `SERVICE_ACCOUNT_JSON` | sì | Contenuto completo del file JSON della chiave del service account. |
| `FIREBASE_PROJECT_ID` | no | Project ID Firebase (default: `project_id` del service account). |
| `SERPAPI_KEYS` | se SerpApi è attiva | Array JSON, **le stesse chiavi** del secret Firebase `SERPAPI_KEYS`, nello stesso ordine, es. `["k1","k2"]`. |
| `RAPIDAPI_KEYS` | se RapidAPI è attiva | Array JSON, le stesse chiavi del secret `RAPIDAPI_KEYS`. |
| `LOG_RESPONSE_BODIES` | no | `true` (default) salva il corpo delle risposte nel log come oggi; `false` lo omette (meno scritture e blocchi più veloci). |
| `EMAIL_ENABLED` | no | `true` (default); `false` disattiva le email di alert delle run schedulate. |
| `MAX_CALLS_PER_RUN` | no | Tetto di sicurezza delle chiamate provider per esecuzione (default 3000). |
| `TEST_SEARCH_ID` | no | Id del documento `flight_searches` usato da `testSingleSearch()`. |

Usare le stesse chiavi, nello stesso ordine, mantiene identici gli id (`sha256("Provider:chiave")`): lo stato di
quota in `engine_state/api_keys` resta condiviso fra script e Functions on-demand.
Le chiavi non compaiono mai nel codice né nei log (sono oscurate come nel backend Firebase).

## 4. Verifica, test e installazione del trigger

Dall'editor, menu a tendina delle funzioni → *Esegui* (la prima volta Google chiede di autorizzare: richieste esterne, trigger, invio email):

1. `checkConfiguration`: mostra nel log progetto, service account, numero di chiavi, ricerche attive, orario configurato ed eventuali problemi.
2. `dryRunSchedule`: mostra slot dovuto, ultimo slot eseguito e prossima esecuzione, senza scrivere né chiamare provider.
3. `testSingleSearch` (con `TEST_SEARCH_ID` impostata) oppure `testSingleSearchById("ID")` da una funzione d'appoggio: esegue subito una sola ricerca salvata con la logica schedulata. Il risultato appare nella webapp (Storico con l'etichetta "Test manuale · Google Apps Script", Risultati), email compresa se ci sono alert.
4. `setupTrigger`: installa il trigger `runScheduler` ogni 5 minuti (rimuove eventuali duplicati).

Altre funzioni:
- `removeTrigger`: rimuove il trigger (lo scheduler si ferma; le Functions on-demand continuano a funzionare).
- `runScheduler`: esegue a mano un passaggio dello scheduler.
- `clearActiveRun`: sblocca lo scheduler se un'esecuzione è rimasta agganciata. Non modifica la sessione: per chiuderla usa "Arresta esecuzione" o "Archivia" nella webapp.

Le email partono dall'account Google proprietario dello script, con il destinatario impostato in Impostazioni → *Email destinataria*.
La quota MailApp di un account Gmail gratuito è di 100 destinatari al giorno. Gli errori del trigger sono visibili in *Esecuzioni* nell'editor Apps Script.

## 5. Rimuovere lo scheduler da Firebase

Il codice di `nightlyFlightSearch` è stato rimosso da `functions/src`. Per eliminarla dal progetto pubblicato
(cancella anche il job Cloud Scheduler `firebase-schedule-nightlyFlightSearch-europe-west1`):

```bash
firebase functions:delete nightlyFlightSearch --region europe-west1 --force
```

Poi pubblica Functions, Hosting e indici aggiornati:

```bash
firebase deploy --only functions,hosting,firestore:indexes
```

In alternativa basta il solo `firebase deploy --only functions`: la CLI rileva la funzione non più presente e chiede conferma per eliminarla.
L'indice `flight_searches (active, nextCheckAt)` non è più usato; `firestore:indexes` propone di eliminarlo.

**Ordine consigliato per la migrazione:** passi 1–4 (trigger attivo) → verifica in Impostazioni che compaia "Prossima esecuzione" →
passo 5. Se per qualche minuto girano entrambi, la transazione su `lastScheduleSlot` impedisce doppie esecuzioni dello stesso slot.

## Test locali

```bash
npm test
```

Dalla radice: compila le Functions, esegue i test del backend e poi `apps-script/test/*.test.cjs`. I file `.js` dello
script sono caricati in una VM Node con stub dei servizi Apps Script e un Firestore REST simulato:
- **Parità:** parsing, URL dei provider, date, combinazioni, rotazione chiavi, link Google Flights e slot di schedulazione vengono confrontati con `functions/lib`.
- **Flusso completo:** blocchi con ripresa senza chiamate duplicate, 429, retry 5xx, arresto, tentativi dei sotto-task, `LOG_RESPONSE_BODIES`, trigger.
