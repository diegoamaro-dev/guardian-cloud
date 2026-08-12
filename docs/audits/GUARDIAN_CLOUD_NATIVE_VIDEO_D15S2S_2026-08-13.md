# Prueba de vídeo nativo — D_15S_2S · 2026-08-13

## 1. Configuración exacta

    preset          D_15S_2S
    rotateAtMs      2000
    rotationIntervalMs  2000
    sessionMs       15000
    adoptador       ENCENDIDO
    dispositivo     ONEPLUS A6000 · Android 11 / API 30
    destino         Google Drive real vía backend proxy
    base            spike/s2-segment-adoption @ 23d03a8, ficheros sin commitear
    cola al armar   vacía (entries=0)

Todos los valores dentro de `HarnessBounds`. No se modificó el grabador nativo,
`app/index.tsx`, GC_QUEUE, el worker, el uploader ni el backend.

## 2. Tiempos, intervalos, tamaños y duraciones

    idx  evento JS    intervalo   bytes     duración MP4
     0   +8434 ms         —       136.035   2,183 s
     1   +10500 ms     2066 ms    186.817   2,579 s
     2   +12561 ms     2061 ms    163.309   2,080 s
     3   +14636 ms     2075 ms    163.753   2,103 s
     4   +16705 ms     2069 ms    143.080   2,070 s
     5   +18785 ms     2080 ms    140.699   2,071 s
     6   +20889 ms     2104 ms    154.124   2,118 s
     7   +21640 ms      751 ms     33.106   0,297 s   cola del cierre ordenado

Cadencia observada 2061–2104 ms frente a los 2000 configurados: 61–104 ms de
sobrecoste por rotación, coherente con los ~115 ms medidos a 3000 ms en S2b.

## 3. Pistas y decodificación

    idx  pistas  vídeo          audio           decodificación
     0     2     h264 640x480   aac 44100 Hz    0 errores
     1     2     h264 640x480   aac 44100 Hz    0 errores
     2     2     h264 640x480   aac 44100 Hz    0 errores
     3     2     h264 640x480   aac 44100 Hz    0 errores
     4     2     h264 640x480   aac 44100 Hz    0 errores
     5     2     h264 640x480   aac 44100 Hz    0 errores
     6     2     h264 640x480   aac 44100 Hz    0 errores
     7     2     h264 640x480   aac 44100 Hz    0 errores

Cada fichero se decodificó íntegro por separado, sin modificar los originales.

## 4. Subida durante la captura

    idx 0, 1 y 2 → remote_reference confirmado con capture_running=true
    idx 3 a 7    → confirmados tras el cierre de la captura

## 5. Integridad extremo a extremo

    8/8 coincidencias entre sha256 del origen temporal, de la copia estable
    y de los bytes descargados de Drive.

## 6. Estado final

    segmentos     8 · índices 0–7 contiguos, sin huecos
    drops         videoFramesDropped = 0 en los ocho
    adopciones    8/8 sin conflictos
    cola final    entries = 0 · sesión completada

## 7. Veredicto doble

    NATIVE_VIDEO_CAPABILITY     PASS
    D_15S_2S_TEST_PROTOCOL      PARTIAL PASS
    E2E_INTEGRITY               PASS
    UPLOAD_DURING_CAPTURE       PASS
    TWO_SECOND_REMOTE_SURVIVAL  NOT_PROVEN

La capacidad nativa queda demostrada: segmentos de ~2,1 s, autocontenidos,
reproducibles, con vídeo H.264 y audio AAC, contiguos y sin frames perdidos.

El protocolo temporal no. +8434 ms mide la recepción del evento en JS desde la
pulsación, no el instante nativo de cierre; y 2,183 s es duración multimedia, no
una marca wall-clock de disponibilidad. **No está demostrado que el primer MP4
estuviera cerrado ni fuera del dispositivo a los dos segundos**, y este criterio
no debe reinterpretarse como PASS retroactivamente.

## 8. Limitación de instrumentación

Falta un reloj común para cuatro hitos que hoy no son comparables entre sí:

    1  inicio nativo de la captura
    2  cierre del muxer de cada segmento
    3  recepción del evento en JS
    4  confirmación remota

Sin ellos, cualquier afirmación sobre disponibilidad a los N segundos es una
inferencia, no una medida.

## 9. Cuello de subida

    productor        un segmento cada ~2,07 s
    coste fijo       ~2,6 s por petición (L medido en S2b, IC95 2474–2806 ms)

El productor va más rápido que el uploader, así que el atraso crece: aquí, tres
subidas durante la captura y cinco después. Es el mismo déficit que S2b
cuantificó, agravado al acortar la cadencia.

## 10. Siguiente experimento propuesto — NO AUTORIZADO

Instrumentar los cuatro hitos del punto 8 sobre un mismo reloj, sin cambiar la
lógica funcional del camino caliente, limitándose a emitir marcas temporales y
midiendo explícitamente el coste añadido. Objetivo: convertir
TWO_SECOND_REMOTE_SURVIVAL de NOT_PROVEN a medible.

## Fuera del alcance de esta prueba

No atribuibles a D_15S_2S: la recuperación manual de 147/147 con su exportación
validada, y la sesión accidental que quedó fuera de GC_QUEUE sin traza de retirada.
