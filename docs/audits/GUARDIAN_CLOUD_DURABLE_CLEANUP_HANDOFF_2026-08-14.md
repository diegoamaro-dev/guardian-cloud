# Handoff — continuación de la limpieza durable · 2026-08-14

Documento de transferencia. Permite continuar sin acceso a la conversación
original. Todo lo que afirma es verificable contra el repositorio.

No contiene UUID completos, rutas internas sensibles, URLs firmadas,
`remote_reference` ni hashes completos de evidencia. Las sesiones aparecen por
prefijo de ocho caracteres.

## 1. Estado de la rama

    rama       feat/native-segmented-recording
    HEAD       b7fc68e4c502c1d5fd8bb8b69b7eabbd7af76844
    remoto     idéntico al local, ya publicado
    árbol      limpio

Ocho commits publicados sobre `364dd9d001909ced4ce4d4711991889eb4e18934`,
cadena lineal:

    1  058cfa4e4675ea9c341b2e27716c835a73ab7d14   padre 364dd9d
       feat(video): add native segmented session orchestration
       Factory por instancia del ciclo de sesión nativa: oyentes, adopciones,
       barrera de cierre y derivación de next_chunk_index desde GC_QUEUE.

    2  9fb68b6fa17acc1d67ef140bc45e3db85710263b   padre 058cfa4
       feat(app): wire native segmented video producer
       Selección exclusiva de productor, orden de arranque local-first,
       predicado único de vida y montaje exclusivo del preview.

    3  31f2be63653948791bba8648b50c33b837acd188   padre 9fb68b6
       test(video): cover native segmented production wiring
       19 casos del módulo de sesión, 3 de selección de productor y el stub
       del módulo nativo en tests/setup.ts.

    4  18b6356e2bf5f11e960116deaae47be76b05c941   padre 31f2be6
       docs(audit): record native segmented integration validation
       Informe de validación en dispositivo y actualización del handoff de
       integración.

    5  e008b0764deae7043e96e05436c3e0941878b831   padre 18b6356
       feat(android): add completed segmented session cleanup
       cleanupCompletedSession en Kotlin y unión cerrada de resultados en el
       puente.

    6  c113649071eec60d1084f31558ad317fecb3338d   padre e008b07
       feat(video): add durable completed session cleanup
       Journal versionado y runner idempotente.

    7  68787b9a10bf8bae4b652e1d6843e94340096596   padre c113649
       feat(app): reconcile durable session cleanup
       Helper único de finalización y reconciliación de arranque.

    8  b7fc68e4c502c1d5fd8bb8b69b7eabbd7af76844   padre 68787b9
       test(video): cover durable session cleanup recovery
       45 casos sobre journal y runner.

## 2. Estado de la integración nativa segmentada

    primer plano              VALIDADO en dispositivo (informe 2026-08-13)
    limpieza durable          IMPLEMENTADA y validada UNITARIAMENTE
    limpieza en hardware      NO VALIDADA
    rama lista para main      NO
    rama lista para release   NO

La validación en primer plano cubrió dos capturas productivas consecutivas con
integridad extremo a extremo verificada contra el destino real. La limpieza
durable se añadió DESPUÉS de esa validación y **no se ha ejecutado nunca en el
dispositivo**.

## 3. Arquitectura de limpieza existente

    journal        guardian.segment_cleanup.v1
                   clave propia en AsyncStorage; nunca GC_QUEUE ni el índice
                   de historial
    autorización   ÚNICAMENTE completeSession 200 o 409 SESSION_ALREADY_COMPLETED
                   Cualquier otro desenlace no autoriza nada
    orden          authorize  →  queueMarkSessionCompleted  →  reapEntry
    recursos       native_cache      cacheDir/gc-segmented-recorder/<sid>/
                   stable_segments   documentDirectory/segments/<sid>/
                   progreso independiente, estados pending/done/absent/blocked

`authorize` no acepta una cadena: recibe un `CompletionAuthorization` cuya marca
es un `unique symbol` nunca exportado y sin valor, así que ningún módulo externo
puede construir uno. `classifyCompletion` es su único productor.

El journal va **antes** de `queueMarkSessionCompleted`, no solo antes de
`reapEntry`: `session_completed = true` basta por sí solo para segar en
`reapAlreadyDoneEntries` y en la rama superior del bucle de finalización, y segar
destruye la última referencia al `sessionId`.

    validación v1  campo a campo, en cada lectura: UUID lowercase canónico,
                   authorized_at_ms finito y no negativo, authorization en la
                   unión, resources con EXACTAMENTE las dos claves, estados
                   conocidos, attempts entero no negativo, last_result en
                   conjunto cerrado o null, sin session_id duplicados.
                   Un solo fallo → documento inutilizable, bytes preservados
                   sin tocar, cero limpiezas, y authorize rechaza.

    Kotlin         @Synchronized sobre el monitor del módulo
                   UUID validado antes de construir ninguna ruta
                   confinamiento comparando canonicalPath contra la base;
                   una canonicalización que lanza es rechazo
                   rechaza sessionActive || releasing para ese id
                   ignora subdirectorios; los cuenta como restantes
                   CLEANED · ALREADY_ABSENT · PARTIAL · SESSION_ACTIVE ·
                   SESSION_ID_INVALID · DIR_UNAVAILABLE
                   remaining = -1 significa "no determinado", nunca "no queda
                   nada"; solo es legítimo en SESSION_ACTIVE, DIR_UNAVAILABLE
                   y PARTIAL

    recuperación   PARTIAL sigue pending y converge al reintentar
    parcial        un recurso ya terminal no se vuelve a intentar

    tombstones     listReconcileCandidates devuelve TODAS las entradas válidas,
    S8→S9          incluidas las de ambos recursos terminales, que solo
                   necesitan el drop que una pasada anterior no persistió

    prioridad      las entradas que pueden conservar bytes se sirven primero;
                   los tombstones toman el presupuesto restante. El cap cuenta
                   todo el trabajo, pero liberar bytes tiene prioridad sobre
                   retirar metadatos terminales

    logs           códigos cerrados. Ningún Error.message, ningún String(err),
                   ninguna ruta, ningún UUID completo, ningún nombre de fichero

    invisibilidad  un directorio sin entrada de journal NO EXISTE para el
                   runner. Ni la edad, ni estar vacío, ni faltar en GC_QUEUE
                   autorizan jamás un borrado

`reapEntry` quedó **sin cambios** a propósito: también corre tras la rendición a
`MAX_COMPLETE_ATTEMPTS`, sin confirmación durable alguna, así que enseñarle a
borrar `segments/<sid>/` destruiría bytes cuya existencia remota nunca se probó.

## 4. Siete defectos corregidos durante la revisión

Todos eran defectos reales de la primera entrega, encontrados en revisión de
código antes de commitear.

    1  authorize silencioso
       Devolvía Promise<void> y podía retornar sin escribir. El helper seguía
       adelante con markCompleted y reapEntry, retirando GC_QUEUE sin prueba
       durable. Ahora devuelve un resultado cerrado y el helper lo comprueba.

    2  documento v1 validado laxamente
       El parser aceptaba cualquier entries[] de versión 1. Ahora valida campo
       a campo y rechaza duplicados.

    3  fugas de errores en logs
       GC_CLEANUP_THREW volcaba err.message; GC_CLEANUP_BOOT_FAILED y el log de
       finalización fallida también. Todos con códigos cerrados ahora.

    4  confianza ciega en resultados del bridge
       Un result desconocido hacía que stateFor devolviera undefined, se
       persistía un journal v1 inválido y en el siguiente arranque TODO el
       journal quedaba inutilizable, bloqueando también sesiones sanas. Ahora
       hay validación runtime cerrada.

    5  reloj no validado
       authorize escribía con clock.now() sin comprobarlo; con NaN, Infinity o
       negativo escribía un documento que su propio parser rechaza y aun así
       devolvía ok:true. Ahora se captura una vez y se valida antes de mutar.

    6  tombstones inmortales
       listActionable filtraba las entradas con ambos recursos terminales, así
       que un drop no persistido las dejaba invisibles para siempre y el
       journal crecía sin techo.

    7  starvation por tombstone atascado
       Incluirlos en el cap sin priorizar permitía que uno con drop fallando
       consumiera el presupuesto pasada tras pasada mientras una sesión con
       bytes esperaba detrás.

## 5. Problema 8 — auditado, no implementado

    ESTADO   AUDITED · READY_TO_IMPLEMENT · NOT_IMPLEMENTED
             BLOCKS_HARDWARE_VALIDATION

El runner solo se activa al arrancar. No hay disparo tras finalizar una sesión.

Mapa real encontrado en la auditoría, en `mobile/app/index.tsx`:

    :2334   construcción del runner
    :4909   ÚNICO call site de reconcile, dentro del efecto de arranque
    :2389   finalizeAndAuthorizeCleanup — el helper
    :2592   llamada al helper desde tryFinalizeReadySessions
    :1505   llamada al helper desde reconcileStaleSessionsWithBackend
    :2435   tryFinalizeReadySessions
    :1971   invocación desde el bucle de drenaje
    :1423   reconcileStaleSessionsWithBackend
    :4934   invocación de esa reconciliación, en el arranque
    :1931   guarda isDraining del drenaje
    :4879   setIsRecovering(false) — GRABAR se desbloquea aquí

Hechos registrados:

    · tryFinalizeReadySessions recorre toda la cola y PUEDE COMPLETAR VARIAS
      SESIONES EN UNA MISMA PASADA; hoy todas quedan sin limpiar
    · el drenaje es single-flight por isDraining, pero eso lo protege de sí
      mismo, NO del solapamiento con la reconciliación de arranque
    · el runner puede tomar su snapshot de candidatos ANTES de que aparezcan
      autorizaciones nuevas; hoy reconcile (:4909) corre incluso antes que
      reconcileStaleSessionsWithBackend (:4934), así que las autorizaciones de
      esa misma pasada tampoco se limpian
    · en consecuencia SOLO SE LIMPIA AL SIGUIENTE ARRANQUE
    · una app abierta durante muchas capturas acumula directorios y entradas de
      journal hasta reiniciarla

El solapamiento no es peligroso —el journal serializa sus escrituras y el nativo
rechaza sesión activa— pero desperdicia pasadas y pospone trabajo.

## 6. Diseño aprobado del scheduler

    createCleanupScheduler({ runner, logger })
      requestCleanup(reason): void      no bloqueante, sin promesa esperable
      whenIdle(): Promise<void>         solo pruebas y diagnóstico

    requestCleanup(reason)
      pending = true
      si running → return
      running = drain()

    drain()
      while (pending) {
        pending = false            ← ANTES de reconcile, nunca después
        try { await runner.reconcile() } catch { log saneado }
      }
      running = null

Bajar `pending` antes de `reconcile` es lo que impide perder una solicitud
llegada durante la pasada: vuelve a subir la bandera y el `while` da otra vuelta.
Bajarla después la descartaría, que es exactamente el fallo del snapshot ya
tomado.

    razones cerradas   'finalized' | 'boot' | 'stale_reconciled'
    errores            saneados, código cerrado, nunca Error.message
    propagación        NINGUNA excepción alcanza el flujo de finalización
    tras error         el scheduler queda utilizable; una solicitud nueva
                       vuelve a ejecutar
    invariante         un fallo de limpieza NUNCA incrementa complete_attempts
                       ni repite completeSession: el backend ya confirmó y
                       GC_QUEUE ya fue retirada

## 7. Triggers aprobados

    requestCleanup('finalized')
      únicamente después de authorize ok, queueMarkSessionCompleted y reapEntry,
      es decir en las ramas de finalizeAndAuthorizeCleanup que devuelven
      'completed' o 'already_completed'

    requestCleanup('stale_reconciled')
      después de reconciliar una sesión stale contra el backend

    requestCleanup('boot')
      SUSTITUYE el await directo de reconcile en :4909

Todos best-effort y no bloqueantes.

El cambio del arranque está aprobado explícitamente y altera comportamiento ya
publicado: hoy el arranque espera a la limpieza. La justificación aceptada es que
la limpieza es mantenimiento durable y recuperable, no debe retrasar recuperación
ni red ni la posibilidad de GRABAR, sus fallos quedan conservados en el journal,
y `reconcileStaleSessionsWithBackend` pedirá otra pasada cuando cree
autorizaciones nuevas.

## 8. Pruebas exigidas

    200 solicita limpieza
    409 solicita limpieza
    resultados no confirmados NO solicitan
    authorize, mark o reap fallidos NO solicitan prematuramente
    dos solicitudes simultáneas comparten una única ejecución
    solicitud durante reconcile provoca EXACTAMENTE otra pasada, no dos
    un error del runner no se propaga al flujo de finalización
    tras un error, una solicitud nueva vuelve a ejecutar
    razones y logs cerrados, sin texto arbitrario
    ninguna sesión sin journal se vuelve visible

    y además: npm test completo, npm run typecheck contra la línea base de 12
    errores preexistentes, y compileDebugKotlin

## 9. Evidencia física preservada

En el dispositivo de pruebas, bajo el directorio de sesiones del módulo nativo:

    sesión validada 1   prefijo 18c93b2b   29 MP4
    sesión validada 2   prefijo 071123c1   14 MP4
    no_capture          prefijo 2d47f332   0 MP4
    no_capture          prefijo 3139834e   0 MP4

Las dos `no_capture` fueron **pulsaciones del usuario**, no de origen
desconocido: capturas iniciadas y detenidas por debajo del preroll, que no
produjeron ningún segmento.

    NINGUNA de las cuatro tiene entrada de journal
    LAS CUATRO siguen intactas y fuera de cualquier limpieza automática

Sin entrada de journal el runner no puede verlas, que es la demostración práctica
de que el diseño es conservador por defecto.

Evidencia congelada fuera del repositorio en `D:\guardian-cloud-evidence`:
manifiestos, logcat, logs de Metro y las descargas de verificación de ambas
sesiones validadas.

## 10. Verificación conocida en b7fc68e

    pruebas dirigidas   45 / 45      journal 21 · runner 24
    npm test            21 ficheros · 339 / 339
    npm run typecheck   12 errores, todos preexistentes · CERO nuevos
    compileDebugKotlin  BUILD SUCCESSFUL
    árbol               limpio

Los 12 errores de typecheck son la línea base histórica del repositorio, en
`app.config.ts`, `app/index.tsx`, `src/api/destinations.ts` y `src/api/export.ts`.
No los introdujo este trabajo y no deben "arreglarse" aquí.

## 11. Deudas abiertas

    problema 8            scheduler auditado y aprobado, sin implementar.
                          BLOQUEA la validación en hardware de la limpieza
    preview temporal      VISIBLE_NATIVE_PREVIEW = TEST_CONFIGURATION
                          HIDDEN_OR_LOCKED_CAPTURE_UX = NOT_VALIDATED
    background            NOT_VALIDATED
    GateHarnessOptions    la ruta productiva sigue pasando por superficie
                          diagnóstica
    guarda de reentrada   startRecording sigue leyendo videoRecordPromiseRef;
                          un timeout dejaría GRABAR pulsable y el módulo nativo
                          rechazaría con INVALID_STATE
    rendición a 5         reapEntry sin confirmación durable: no crea
    intentos              cleanup_pending y esos directorios se acumulan sin
                          ruta de salida. Deuda separada, aceptada
    build local           depende de montar el worktree en una unidad corta con
                          subst: el límite de 260 caracteres está compilado en
                          ninja y LongPathsEnabled de Windows no lo evita
    mobile/.env           ignorado por git, no existe en un worktree nuevo;
                          hay que copiarlo antes de arrancar Metro

## 12. Instrucciones para quien continúe

Antes de tocar nada:

    1  leer docs/START_HERE.md
    2  leer docs/audits/
       GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md
    3  leer este handoff
    4  verificar rama, HEAD, upstream y árbol contra la sección 1
    5  confirmar la auditoría de la sección 5 contra el código: los números de
       línea son de b7fc68e y se desplazan con cualquier edición

Después:

    6  implementar ÚNICAMENTE el scheduler aprobado en la sección 6 y sus tres
       triggers de la sección 7
    7  detenerse ANTES de commitear
    8  no ejecutar la app, no instalar APK, no tocar el dispositivo, no tocar
       las evidencias, no borrar directorios

La validación en hardware de la limpieza queda bloqueada hasta que el scheduler
exista: sin él solo se limpia al reiniciar, y una prueba en dispositivo no
demostraría el comportamiento previsto.
