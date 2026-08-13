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
    suite JS          17 suites · 271 pruebas · verde

## Productor y adoptador: sin cablear

El grabador nativo y `segmentAdopter.ts` conviven en la rama pero **no se
conectan entre sí**. Nadie llama a `adoptSegment` desde el flujo productivo, y
`onSegmentClosed` no tiene ningún oyente fuera de los harnesses, que viven en
`spike/s2-segment-adoption` y no se han portado.

## Decisión de producto

    vídeo segmentado   → productor nativo (gc-segmented-recorder)
    expo-camera        → fallback temporal, se conserva
    selección          exclusiva, mediante bandera de integración:
                       una y solo una ruta de captura activa por sesión

El productor anterior NO se retira. La bandera decide cuál manda; nunca
coexisten en la misma grabación.

## Pendientes

    cableado productivo   onSegmentClosed → ClosedSegment → adoptSegment →
                          QueueSink → queueAppendChunk → worker existente
    build instalada       cambió código Kotlin: hace falta development build nueva
    prueba doble          dos grabaciones con UUID distintos, demostrando que la
                          segunda conserva los originales de la primera, escribe en
                          otro directorio y no produce SESSION_DIR_NOT_EMPTY
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

Inspección **de solo lectura** de `mobile/app/index.tsx`: mapear el flujo
productivo de vídeo, identificar inicio, eventos, cierre y creación/cierre de la
entrada de GC_QUEUE. Sin editar ningún fichero.

## Prohibiciones vigentes

    sin merge
    sin PR
    sin tag
    sin retirar el productor anterior
