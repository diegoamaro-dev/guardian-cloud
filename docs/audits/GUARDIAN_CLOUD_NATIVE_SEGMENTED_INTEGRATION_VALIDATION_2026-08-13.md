# Validación del cableado de vídeo segmentado nativo · 2026-08-13

Registro de lo ejecutado y observado. No reinterpreta resultados ni declara
resuelta ninguna deuda.

## Alcance

    rama       feat/native-segmented-recording
    base       364dd9d001909ced4ce4d4711991889eb4e18934
    ficheros   ocho: tres módulos nuevos, tres suites/stub de prueba,
               app/index.tsx y este bloque documental
    dispositivo ONEPLUS A6000 · Android 11 / API 30

Los identificadores de sesión aparecen solo por prefijo de ocho caracteres. No
se registran UUID completos, remote_reference, URLs firmadas ni hashes de
contenido de sesión.

## Build

    tarea      ./gradlew assembleDebug --no-daemon
    resultado  EXIT 0 · 28 min 43 s · 689 tareas, 139 ejecutadas
    APK        mobile/android/app/build/outputs/apk/debug/app-debug.apk
    tamaño     206.354.862 bytes
    sha256     738eed4b8f506eb9906a9cf69e0d98931f9ad28e351118f12829f25e32940f9b
    variante   debug · SINGLE, sin splits
    ABIs       arm64-v8a · armeabi-v7a · x86 · x86_64
    módulo     GCSegmentedRecorderModule presente en classes2.dex, junto a
               GCSegmentedCameraView, SegmentCoordinator, VideoEncoder y AudioEncoder

## Verificación estática

    suite JS       19 ficheros · 294 / 294 pruebas verde   (271 base + 23 nuevas)
    typecheck      12 errores, todos preexistentes · CERO nuevos
                   los cuatro de app/index.tsx solo cambian de línea por las
                   inserciones: 2804→2826, 2932→2954, 3031→3053, 3113→3192

## Primera captura integrada — sesión 18c93b2b

    protocolo   DESVIACIÓN — 179,436 s de captura frente a los ~20 s fijados.
                El sobrepaso se debe al tiempo consumido en las comprobaciones
                de arranque; se registra como prueba prolongada no planificada.
    resultado   PASS · 14 / 14 criterios

    productor único, expo-camera sin grabar en paralelo
    directorio propio bajo cacheDir/gc-segmented-recorder/<sesión>/
    29 segmentos · índices 0..28 contiguos · sin huecos
    cero drops en los 29 (coord_video_dropped y coord_audio_dropped a 0)
    29 eventos onSegmentClosed → 29 adopciones → 29 índices únicos
    los 29 devolvieron "adopted", que solo se emite tras verificar existencia,
      tamaño y sha256 de la copia estable
    primera subida confirmada a los 15,2 s de una captura de 179 s
    27 de 29 subidas cerradas ANTES de pulsar PARAR
    onCaptureReleased con resources_freed=true y leaked=[]
    barrera: RELEASED → CLOSE_WAITING(in_flight=1) → CLOSED
    next_chunk_index derivado de los chunks durables: 29
    puerta de completitud: 29 esperados, 29 subidos, faltantes []
    sesión completada y GC_QUEUE = []
    29/29 con vídeo H.264 y audio AAC, decodificación sin errores

    cadencia    suma 173,752 s de medio · media 5,991 s
                seg_000 3,204 s (rotateAtMs=3000)
                intermedios 5,9–6,6 s (rotationIntervalMs=6000)
                seg_028 4,872 s (cola del cierre ordenado)

## Segunda captura integrada — sesión 071123c1

    resultado   PASS · 12 / 12 criterios

    onCaptureReleased con resources_freed=true y leaked=[] · captura 84,099 s
    barrera completada antes de recording_closed
    14 segmentos · índices 0..13 contiguos · 14 índices únicos
    cero drops en los 14
    14 adopciones, todas "adopted"
    puerta de completitud: 14 esperados, 14 subidos, faltantes []
    sesión completada y GC_QUEUE = []
    14/14 con H.264 y AAC, decodificación sin errores
    duración de medio 78,428 s · media 5,602 s

## Aislamiento entre sesiones — PASS

    directorios nativos          exactamente 2, uno por sesión
    SESSION_DIR_NOT_EMPTY        ninguna aparición
    segunda ruta de captura      ninguna · 2 PRODUCER_SELECTED en toda la ejecución
    sesión 1 tras la sesión 2    29 MP4 presentes
    manifiesto de la sesión 1    29/29 idéntico en las tres comprobaciones:
                                 antes de la segunda captura, justo después y
                                 al cierre de la fase
    mtimes de la sesión 1        19:04–19:07, su propia ventana de captura;
                                 la sesión 2 corrió a las 21:26–21:28

Los hashes de la sesión 1 se calcularon siempre EN EL DISPOSITIVO, sobre los
ficheros en su sitio, sin extraerlos.

## Integridad extremo a extremo

    sesión 18c93b2b   29 / 29   bytes descargados de Drive == originales nativos
    sesión 071123c1   14 / 14   bytes descargados de Drive == originales nativos
    vacíos 0 · tamaño distinto 0 · hash distinto 0 · fallos de transporte 0

La comparación efectiva es original nativo ↔ Drive. El eslabón intermedio —la
copia estable bajo documentDirectory/segments/— ya no existe al verificar: el
worker borra cada local_uri tras confirmar su subida, que es el comportamiento
diseñado. Su integridad quedó establecida en el momento de la adopción.

## Camino deferred_offline observado

La segunda sesión arrancó con `deferred_offline: true`: el alta remota no salió
al primer intento y entró en el registro diferido existente. La captura, la
adopción y el encolado siguieron sin esperar a la red; los 14 chunks acabaron
subidos y la sesión se completó. Escenario no planificado, cubierto sin
intervención.

## Dependencia de entorno en la build local

`ninja` rechaza por su cuenta cualquier ruta de más de 260 caracteres — la
comprobación está compilada en su binario, no depende de `LongPathsEnabled` de
Windows, y habilitar rutas largas no la evita. La ruta de objeto del codegen C++
de react-native-safe-area-context mide 303 caracteres relativos desde el
directorio de `ninja`.

La build local de esta rama solo termina montando el worktree en una unidad
corta con `subst`, lo que reduce esa ruta por debajo del límite. Es deuda de
entorno, no de código: cualquiera que compile desde una ruta larga volverá a
chocar.

## Deudas abiertas — ninguna resuelta

    limpieza durable        sin implementar. cacheDir/gc-segmented-recorder/<uuid>/
                            se acumula sin techo; ya hay dos directorios
    preview de 170 px       VISIBLE_NATIVE_PREVIEW = TEST_CONFIGURATION
                            HIDDEN_OR_LOCKED_CAPTURE_UX = NOT_VALIDATED
    background              NOT_VALIDATED · no probado en esta fase
    GateHarnessOptions      sigue siendo superficie diagnóstica y la ruta
                            productiva pasa por ella
    guarda de reentrada     startRecording sigue leyendo videoRecordPromiseRef;
                            un timeout dejaría GRABAR pulsable y el módulo
                            nativo rechazaría con INVALID_STATE

## Veredicto

    INTEGRACIÓN EN PRIMER PLANO      VALIDADA
    LISTA PARA MAIN                  NO
    LISTA PARA RELEASE               NO

Sin probar en esta fase: background, kill app, timeout de liberación,
no_capture, adoption_failed, rechazo remoto no reintentable y fallback a
expo-camera.
