# Handoff de integración — grabador segmentado nativo · 2026-08-13

## Ubicación

    rama       feat/native-segmented-recording
    worktree   D:\guardian-cloud-worktrees\native-segmented-recording
    HEAD       f24584db4c01648f214ff10727e0affda0bacda5
    remoto     origin/feat/native-segmented-recording, idéntico al local

## Commits heredados

    f24584d  fix(android): isolate segmented recording output by session
    6a9dd5a  feat(android): preserve validated segmented recorder module
    a1e97e9  test(video): cover segment adopter integrity
    ff039e6  refactor(video): inject segment adoption queue sink
    ec449e1  spike(video): preserve validated segment adopter

Cinco commits sobre `main @ 2d7e583`.

## Estado compilado

    proyecto Gradle   :gc-segmented-recorder      (descubierto con ./gradlew projects)
    tarea             :gc-segmented-recorder:compileDebugKotlin
    resultado         EXIT=0, sin errores; solo avisos de expo-modules-core
    suite JS          19 suites · 294 pruebas · verde   (271 base + 23 nuevas)
    typecheck         12 errores, todos preexistentes; CERO nuevos

    assembleDebug     FALLO AMBIENTAL — ver "Build local bloqueada"

## Productor y adoptador: CABLEADOS Y VALIDADOS EN DISPOSITIVO

El cableado está implementado y validado en primer plano sobre el OnePlus A6000,
con dos capturas productivas consecutivas y verificación de integridad extremo a
extremo contra Drive.

    informe completo   docs/audits/
                       GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md

    primera captura    PASS 14/14 · 29 segmentos · desviación de protocolo:
                       179,4 s de captura frente a los ~20 s fijados
    segunda captura    PASS 12/12 · 14 segmentos
    aislamiento        PASS · dos directorios, sin SESSION_DIR_NOT_EMPTY,
                       la primera sesión intacta 29/29 en tres comprobaciones
    integridad         29/29 y 14/14 · Drive == originales nativos
    suite JS           19 ficheros · 294/294
    typecheck          12 preexistentes · cero nuevos

    INTEGRACIÓN EN PRIMER PLANO   VALIDADA
    LISTA PARA MAIN               NO
    LISTA PARA RELEASE            NO

    onSegmentClosed → ClosedSegment → adoptSegment → QueueSink
                    → queueAppendChunk → worker existente

La sesión nativa es una instancia explícita —`createNativeSegmentedSession(deps)`,
sin estado de módulo— que `app/index.tsx` conserva en un `useRef`. Toda su
superficie está inyectada: API del grabador, adoptador, sink productivo, sink de
solo preservación, lectura de cola, marcado de cierre, drenaje, logger y reloj.

Decisiones incorporadas:

    bandera            NATIVE_SEGMENTED_VIDEO = true en esta rama
    cadencia           rotateAtMs 3000 · rotationIntervalMs 6000 · sessionMs 3600000
    orden de arranque  entrada local de GC_QUEUE ANTES de abrir la cámara;
                       la cámara nunca espera a la red
    UI                 "Grabando" cuando la captura está viva Y la entrada existe
    puerta de drenaje  las patadas de ESTE cableado esperan a remoteSessionReady;
                       los drenajes globales existentes no se tocan
    cierre             barrera: onCaptureReleased → snapshot → allSettled →
                       leer GC_QUEUE → next = max(chunk_index)+1 → marcar → drenar
    cero chunks        'no_capture' retira la entrada; 'adoption_failed' cierra
                       con next = max(observado)+1 y queda demostrablemente
                       incompleta, sin completeSession
    timeout            no escribe nada; lo gestiona el recovery del siguiente arranque

## Ficheros afectados — los siete

    M  mobile/app/index.tsx                          +390 −28   siete puntos acotados
    M  mobile/tests/setup.ts                         +21        stub del módulo nativo
    ?? mobile/src/video/nativeSegmentedFlag.ts        20 líneas
    ?? mobile/src/video/selectVideoProducer.ts        32
    ?? mobile/src/video/nativeSegmentedSession.ts    775
    ?? mobile/tests/nativeSegmentedSession.test.ts   730
    ?? mobile/tests/selectVideoProducer.test.ts       38

SHA-256 de la copia de trabajo y copia de recuperación fuera del worktree: ver
`D:\guardian-cloud-recovery\native-segmented-wiring-2026-08-13\MANIFEST.sha256`.

Evidencia de las dos capturas, fuera del repositorio y congelada:

    D:\guardian-cloud-evidence\first-integrated-capture-2026-08-13\
    D:\guardian-cloud-evidence\second-integrated-capture-2026-08-13\

No se tocaron: cola, worker, recovery, orphanScan, export, backgroundService,
audioEngine, backend, módulo Kotlin ni el adoptador.

## Build local condicionada — límite propio de ninja

RESUELTA SOLO COMO PROCEDIMIENTO, no como corrección: la build únicamente
termina montando el worktree en una unidad corta con `subst`, porque la
comprobación de 260 caracteres está compilada en `ninja` y `LongPathsEnabled`
de Windows no la evita. Sigue siendo deuda de entorno. Detalle abajo.

## Diagnóstico original — MAX_PATH

    comando   ./gradlew assembleDebug --no-daemon
    exit      1 · 14 min 51 s · 668 tareas, 623 ejecutadas
    fallida   :app:buildCMakeDebug[arm64-v8a]   (única)
    error     ninja: Filename longer than 260 characters
    ruta      407 caracteres, codegen C++ de react-native-safe-area-context
    sistema   LongPathsEnabled = 0

No es una regresión del cableado: la tarea que falla es el codegen C++ de una
dependencia y `gc-segmented-recorder` compila correctamente en el mismo log.
Desde este worktree `assembleDebug` no se había ejecutado nunca — el estado
anterior solo acreditaba `compileDebugKotlin`, que no toca la cadena C++.

Acortar la raíz NO lo resuelve. La ruta contiene la raíz dos veces (prefijo de
`.cxx` y ruta absoluta manglada dentro del nombre del objeto):

CORRECCIÓN. El primer análisis se hizo sobre la ruta ABSOLUTA (407 caracteres) y
concluyó que acortar la raíz no servía. Es incorrecto: `ninja` evalúa la ruta
RELATIVA al directorio en el que entra.

    ruta evaluada                    303 caracteres
    de ellos, la raíz del worktree    51
    sin esa raíz                     252   < 260

Acortar la raíz SÍ resuelve. Medido:

    subst X:  →  251   funciona, con margen de 9
    enlace corto D:\g  →  253
    repo principal D:\guardian-cloud  →  266   NO basta, se pasa por 6

Y el límite es de `ninja`, no de Windows: la cadena "Filename longer than" está
compilada en su binario, así que `LongPathsEnabled=1` —habilitado y reiniciado—
no cambió nada.

## Decisión de producto

    vídeo segmentado   → productor nativo (gc-segmented-recorder)
    expo-camera        → fallback temporal, se conserva
    selección          exclusiva, mediante bandera de integración:
                       una y solo una ruta de captura activa por sesión

El productor anterior NO se retira. La bandera decide cuál manda; nunca
coexisten en la misma grabación.

## Pendientes

    build local           condicionada a montar el worktree con `subst`; deuda de
                          entorno, no corregida
    entorno de worktree   mobile/.env no existe en un worktree nuevo por estar
                          ignorado; hay que copiarlo antes de arrancar Metro
    background            OBSERVED_RELEASE · P2_PRODUCTIVE_BACKGROUND_CAPABILITY
                          NOT_VALIDATED. Se registra como FAIL propio, nunca
                          mezclado con un PASS en primer plano
    limpieza durable      sin implementar por diseño. Alcance: operación explícita,
                          posterior a confirmación durable, que borre
                          cacheDir/gc-segmented-recorder/<uuid>/. Mientras no
                          exista, los directorios de sesión se acumulan sin techo
    API diagnóstica       GateHarnessOptions y HarnessBounds siguen en la superficie
                          pública de startSegmentedCapture: deuda arquitectónica
                          pendiente; no bloquea la prueba integrada

## Siguiente acción exacta

La integración en primer plano está validada y preservada en Git. Lo que queda
antes de plantear la fusión a `main`:

1. Escenarios de fallo sin probar: background, kill app, vencimiento de
   liberación, `no_capture`, `adoption_failed`, rechazo remoto no reintentable y
   fallback a expo-camera.

2. Decidir la UX de captura — el preview de 170 px es configuración de
   validación, no diseño definitivo.

3. Resolver las deudas de la sección anterior. Ninguna está cerrada.

Para reproducir el entorno en un worktree nuevo: copiar `mobile/.env`, montar la
raíz con `subst` y arrancar Metro sirviendo por la IP de LAN — el dev client
abre por `127.0.0.1`, que `network_security_config.xml` no permite.

## Prohibiciones vigentes

    sin merge
    sin PR
    sin tag
    sin retirar el productor anterior
