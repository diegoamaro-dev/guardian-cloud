# ADR — Captura y segmentación de vídeo nativas

| | |
|---|---|
| **Estado** | Decisión arquitectónica **aceptada**. Pipeline concreto **pendiente de spike** |
| **Fecha** | 2026-07-30 |
| **Decide** | Propietario del producto |
| **Afecta a** | `GC-AUD-001`, fase C y D del plan de remediación 2026-07-28 |
| **Reemplaza** | El enfoque de leer un MP4 en escritura desde JavaScript |
| **Refinado por** | [`ADR-VIDEO-PIPELINE-SELECTION`](./ADR-VIDEO-PIPELINE-SELECTION.md) |

---

## Veredicto

```
Decisión: segmentación nativa obligatoria.
Pipeline concreto: pendiente del spike P1/P2.
Candidato inicial: Camera2 + MediaRecorder.setNextOutputFile en API 26+.
```

---

## 1. Contexto

`GC-AUD-001` es el incumplimiento central del producto: **en modo vídeo no sale
nada del dispositivo mientras se graba**. La evidencia vive solo en el móvil
hasta que el usuario pulsa PARAR. Si el dispositivo se pierde, se confisca o se
destruye durante la grabación, sobrevive cero evidencia. Eso contradice el
principio del producto: *«si grabas unos segundos, al menos una parte ya está
fuera del dispositivo»*.

Se intentaron dos aproximaciones desde JavaScript y ambas quedan descartadas:

**Chunker en vivo sobre el MP4 creciente** (`runVideoChunkerTick`, abril 2026).
Leía trozos del fichero mientras el recorder seguía escribiéndolo. Recibió un
parche por carrera de hash (`cc799fc`) y fue desviado a chunking post-stop 41
horas después (`426d438`), sin documentar el motivo. El código sigue en el
repositorio, desactivado por un gate en `mobile/app/index.tsx`.

**Rotación repetida de `recordAsync()`** desde JS. Descartada por decisión de
producto: parar y rearrancar la sesión pierde contenido en cada frontera, y ese
hueco es exactamente lo que el producto no puede permitirse.

### Evidencia preliminar disponible

Un experimento del spike comparó un MP4 capturado a mitad de escritura contra el
mismo fichero ya finalizado. **Se produjo con `adb screenrecord`
(`MediaMuxer`), no con la ruta de cámara de la aplicación.** No valida ninguna
alternativa de la fase C y no supera ningún criterio `C-AC`.

Lo observado en ese productor: a mitad de escritura no existía `moov` y el
`mdat` declaraba un `largesize` sin escribir; al finalizar, **543 bytes en 131
rangos** habían cambiado, 529 de ellos donde se escribió el `moov`.

> Es un **indicio**, no una demostración sobre Guardian Cloud. Sugiere que leer
> un contenedor MP4 mientras está abierto expone al lector a bytes que el
> productor todavía puede reescribir. No lo prueba para la ruta real.

La prueba equivalente sobre la ruta real **no se pudo ejecutar**: el APK de
validación es release y no depurable, el dispositivo no está rooteado, y el
vídeo se escribe en almacenamiento privado de la aplicación.

---

## 2. Decisión

**El vídeo crítico de Guardian Cloud usa captura y segmentación nativas en
Android.** Un módulo nativo mantiene la sesión de captura, cierra segmentos
periódicamente y los entrega a JavaScript para su encolado inmediato.

React Native / Expo **se mantienen** para interfaz, coordinación y lógica
general. **No se reescribe la aplicación.** El alcance del código nativo se
limita a la captura y segmentación de vídeo.

### El módulo nativo es dueño de la sesión de cámara

```
sesión nativa de cámara
├── superficie de preview
└── superficie de grabación
    ├── segmento 0
    ├── segmento 1
    └── segmento N
```

**Una sola sesión, con múltiples usos.** La superficie de previsualización y la
de grabación se alimentan de esa misma sesión.

**No se reparte la propiedad de la cámara entre dos pipelines.** Abrir una
segunda captura en paralelo mientras otro componente conserva su propia sesión
es un diseño distinto, dependiente del dispositivo, y no representa la
arquitectura de producción deseada.

Consecuencia directa: en modo vídeo, **la previsualización deja de venir de la
`CameraView` de `expo-camera`** y pasa a proceder de la superficie que expone el
módulo nativo.

### Papel de React Native

Se limita a:

- iniciar y detener la captura;
- mostrar estado;
- recibir eventos de **segmento cerrado**.

**No controla la rotación.** La política de segmentación vive íntegra en el
módulo nativo.

### Lo que NO cambia

Camino de **audio**, `GC_QUEUE` como fuente de verdad y su forma de entrada,
**worker** single-flight con sus reintentos, **recovery** automático y
**backend**.

### Por qué la frontera nativa↔JS ya existe

La entrada de cola admite `local_uri`: el worker rehidrata los bytes leyendo un
fichero local en el momento de subir, en vez de llevar el contenido dentro de la
fila. Se introdujo para el vídeo post-stop y el audio la adoptó después.

Consecuencia: **el módulo nativo puede escribir cada segmento en disco y
entregar a JavaScript únicamente una ruta y sus metadatos.** El sink existente
lo persiste y el worker lo consume sin cambios. Es el punto de integración más
barato disponible y la razón por la que esta decisión no obliga a tocar el
transporte.

> **Condición no demostrada:** que el fichero del segmento anterior esté
> **cerrado, completo y estable** en el momento en que JavaScript lo recibe.
> Toda la baratura de esta integración depende de ello. **Es la condición
> eliminatoria que el spike debe probar**, no un supuesto de partida.

---

## 3. Alternativas — pipelines completos

Se comparan **pipelines completos**, es decir, quién es dueño de la sesión de
cámara **y** qué mecanismo produce los segmentos. No tiene sentido comparar
CameraX con `setNextOutputFile()`: el primero controla la sesión, el segundo es
una pieza del mecanismo de grabación.

**Ninguno está medido.** Lo que sigue es análisis de diseño con su nivel de
confianza declarado.

### P1 — `Camera2` + `MediaRecorder.setNextOutputFile()` · API 26+

Sesión Camera2 propia que alimenta preview y la superficie de `MediaRecorder`.
La rotación la encadena el propio recorder.

- **Segmentos:** MP4 completos con su propio `moov`, en principio reproducibles
  por separado. *No verificado.*
- **Hueco:** por diseño, la transición ocurre sin detener el encoder.
  *Confianza alta sobre la intención de la API; cero verificación aquí.*
- **Rotación:** **por límite de tamaño, no por tiempo.** Ver §4.
- **Disponibilidad:** **API 26+**. El proyecto declara minSdk 24 → ver §6.
- **Dependencias:** ninguna. APIs de plataforma.
- **Coste:** medio.

### P2 — `Camera2` + `MediaCodec` + `MediaMuxer` · API 24+

Sesión Camera2 propia; la cámara alimenta un `MediaCodec` que codifica de forma
continua. Solo se rota el `MediaMuxer` en la frontera, solicitando un fotograma
de sincronización antes para que cada segmento empiece en un keyframe.

- **Segmentos:** MP4 completos que **deberían** empezar en IDR. Es un objetivo
  del diseño, no un resultado: exige solicitar el fotograma de sincronización y
  que el encoder lo entregue antes de rotar. **Sin demostrar.**
- **Hueco:** el diseño **pretende** que no lo haya, porque el encoder no se
  detiene y solo rota el contenedor. **Objetivo de diseño, no resultado
  medido.**
- **Rotación:** **por tiempo, tamaño o keyframe, a elección.** Control fino.
- **Disponibilidad:** API 24+. Cubre todo el rango actual.
- **Dependencias:** ninguna. APIs de plataforma.
- **Coste:** **alto.** Hay que asumir cámara→superficie, `AudioRecord`→AAC,
  alineación de timestamps y sincronía A/V a través de fronteras.
- **Dependencia del fabricante:** **evita depender de la rotación de
  `MediaRecorder`, aunque `Camera2`, `MediaCodec` y los encoders continúan
  sujetos a variaciones entre fabricantes.**

### P3 — `CameraX VideoCapture` con grabaciones sucesivas

CameraX es dueño de la sesión; se cierra la grabación en curso y se arranca la
siguiente.

- **Segmentos:** se espera que cada grabación genere un MP4 cerrado, pero su
  reproducibilidad independiente está **pendiente de verificación**.
- **Hueco:** **estructural.** La grabación se finaliza y se rearranca; el
  contenido entre ambos momentos se pierde. *Confianza media-alta: CameraX no
  expone rotación sin corte equivalente a `setNextOutputFile`.*
- **Dependencias:** ninguna nueva. CameraX 1.5.0-rc01 ya entra como dependencia
  transitiva de `expo-camera`.
- **Coste:** bajo.

> **Es el mismo defecto estructural que la rotación de `recordAsync()`**, solo
> que en Kotlin. Si aquella fue rechazada por el hueco, esta hereda el rechazo
> salvo que la medición demuestre que el hueco es despreciable.

### P4 — Pipeline fMP4 nativo

Segmento de inicialización seguido de fragmentos. En principio facilitaría el
ensamblado a partir de un prefijo.

- **Ensamblado:** **potencialmente ensamblable con init segment y continuidad
  verificadas.** No es una concatenación trivial garantizada: depende de que el
  segmento de inicialización esté presente y sea el correcto, de que la
  configuración de pistas no cambie, y de que timestamps, identificadores y
  números de secuencia de fragmento sean continuos. **Todo ello hay que
  verificarlo, no suponerlo.**
- **Bloqueo probable:** el `MediaMuxer` de Android **no expone salida fMP4**.
  Producirlo exigiría un muxer de terceros o escribirlo a mano.
  *Confianza media — requiere verificación antes de descartarlo.*
- **Dependencias:** **probablemente sí**, lo que choca con la restricción de no
  añadir dependencias.
- **Coste:** alto, con riesgo de licencia y mantenimiento.

### Comparación

| | P1 Camera2+MediaRecorder | P2 Camera2+MediaCodec+Muxer | P3 CameraX sucesivas | P4 fMP4 |
|---|---|---|---|---|
| API mínima | **26** | 24 | 24 | Depende |
| Hueco entre segmentos | Objetivo de diseño: ninguno | Objetivo de diseño: ninguno | **Sí, estructural** | Objetivo de diseño: ninguno |
| Criterio de rotación | **Tamaño** | Tiempo / tamaño / keyframe | Manual | Fragmento |
| Segmento reproducible solo | **Pendiente de verificación** | **Pendiente de verificación** | **Pendiente de verificación** | Pendiente de verificación |
| Dependencias nuevas | Ninguna | Ninguna | Ninguna | **Probables** |
| Control de duración | **Indirecto** | Fino | Grueso | Fino |
| Variación entre fabricantes | Rotación de `MediaRecorder` + encoders | `Camera2`, `MediaCodec` y encoders | CameraX + encoders | Encoders + muxer |
| Coste | Medio | **Alto** | Bajo | Alto |
| Reconstrucción del export | Concat/remux | Concat/remux | Concat/remux | Potencialmente ensamblable con init segment y continuidad verificadas |
| **Medido** | **No** | **No** | **No** | **No** |

---

## 4. `setNextOutputFile()` rota por tamaño, no por tiempo

Punto crítico para P1, y fuente de un error de diseño si se pasa por alto.

La rotación se dispara al alcanzar el límite configurado con `setMaxFileSize()`.
La duración de cada segmento no se fija: **se deriva del bitrate**, de forma
aproximada:

```
duración_segmento ≈ tamaño_máximo / bitrate_real
```

Con bitrate variable esa relación es solo orientativa. Una escena estática y una
con mucho movimiento producen segmentos de duraciones muy distintas para el
mismo límite de tamaño.

**Consecuencia:** la latencia hasta la primera evidencia remota **no es
directamente configurable** en P1. Se ajusta indirectamente eligiendo tamaño
máximo y bitrate, y hay que medir la dispersión resultante.

### Lo que el spike debe medir en P1

| Qué | Por qué importa |
|---|---|
| Precisión temporal obtenida según bitrate y tamaño máximo | Determina si la latencia es acotable |
| Evento `MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED` | Es la señal de que la rotación ocurrió |
| **Momento exacto en que el segmento anterior puede abrirse, hashearse y encolarse** | **Condición eliminatoria** |
| Reproducción independiente **con audio** | `C-AC7`, `C-AC9` |
| Huecos o pérdida de fotogramas en la frontera | `C-AC4` |
| **Estabilidad del hash después de continuar grabando** | Un segmento cuyo hash cambie más tarde repetiría el fallo de abril |
| Comportamiento si no se proporciona el siguiente fichero a tiempo | Modo de fallo bajo carga o latencia de disco |
| Variaciones entre fabricantes | La implementación de `MediaRecorder` es del OEM |

> **No se da por demostrado que el fichero anterior quede cerrado y listo para
> subir al recibirse el evento.** Es precisamente lo que hay que probar.

---

## 5. Estado de las alternativas

**P1 es la primera candidata experimental, pendiente de viabilidad e
integridad.** No es la solución recomendada: ninguna alternativa tiene un solo
criterio `C-AC` superado.

- **P1** merece el primer spike por coste medio y rotación sin corte por diseño.
  Su viabilidad depende de §4 y de la condición eliminatoria.
- **P2** es la alternativa seria si P1 falla. Cubre API 24+ y da control fino.
  **Evita depender de la rotación de `MediaRecorder`, aunque `Camera2`,
  `MediaCodec` y los encoders continúan sujetos a variaciones entre
  fabricantes.** A cambio, es la más cara.
- **P3** parte descartada por el mismo motivo que la rotación de `recordAsync`.
  Solo volvería si se midiera el hueco y resultara despreciable.
- **P4** se aparca hasta verificar si existe vía sin dependencias.

---

## 6. API 24–25 — decisión abierta

P1 exige API 26. El proyecto declara **minSdk 24**, así que Android 7.0 y 7.1
quedarían fuera. **Tres opciones, ninguna elegida todavía:**

| Opción | Implicación |
|---|---|
| **A · Elevar `minSdk` a 26** | Se pierden Android 7.0/7.1. Un solo pipeline |
| **B · Mantener minSdk 24 y deshabilitar el modo vídeo en API 24–25** | La app instala, pero **el modo vídeo queda completamente deshabilitado y se declara incompatible**. Un solo pipeline |
| **C · Segundo pipeline P2 como fallback en API 24–25** | Cobertura completa, **dos implementaciones del corazón del producto** |

> **En la opción B no existe un «vídeo menos protegido».** O se ofrece vídeo que
> cumple el contrato, o el modo vídeo se deshabilita por completo declarando
> incompatibilidad. **No se ofrece vídeo post-stop ni ninguna modalidad
> degradada presentada como protegida.** Ofrecer una versión que aparenta
> proteger sin hacerlo es peor que no ofrecer nada: el usuario grabaría creyendo
> que su evidencia sale del dispositivo.

> **La opción C multiplica la matriz de pruebas y el riesgo.** Cada criterio
> `C-AC` habría que verificarlo dos veces, sobre dos pipelines con modos de
> fallo distintos, en una funcionalidad crítica de seguridad. Duplicar el
> corazón de la aplicación es deuda desde el primer día.
>
> Criterio expresado por el propietario, registrado aquí sin cerrar la decisión:
> no mantendría Android 7 con un segundo pipeline **salvo que existan usuarios
> reales que lo necesiten**. Decidir con datos de uso, no por cobertura teórica.

---

## 7. Export — dentro del alcance de la aprobación

**Corrección de alcance:** el export no es una cuestión ajena a la integración.
Su *implementación* puede ir después, pero **una estrategia de reconstrucción
verificable debe quedar definida antes de aprobar la arquitectura**, porque
forma parte de `C-AC11`.

Hoy el export reconstruye concatenando el prefijo contiguo de bytes. Es válido
para AAC ADTS por ser auto-delimitado. **Con segmentos MP4 cerrados, concatenar
bytes no produce un fichero válido.**

Antes de aprobar el pipeline hay que responder, con demostración:

1. ¿Cuál es el mecanismo de reconstrucción — concatenación con remux, índice
   reescrito, cabecera separada?
2. ¿Qué obtiene el usuario si faltan segmentos intermedios?
3. ¿Qué obtiene si falta el segmento 0? (`C-AC10` exige que el sistema lo
   **declare**, nunca corrupción silenciosa ni falso éxito.)
4. ¿El resultado se abre en reproductores estándar? (`C-AC8`)

Aprobar la arquitectura sin responderlas sería repetir el patrón que la
auditoría reprocha al proyecto: asumir sin prueba que un fragmento de vídeo se
comporta como uno de audio.

---

## 8. Consecuencias

### Aceptadas

- Guardian Cloud pasa a tener **código nativo Android propio** en el camino
  crítico. Aumenta la superficie de mantenimiento y obliga a compilar para
  probar.
- En modo vídeo, la previsualización deja de venir de `expo-camera`.
- **iOS queda fuera de alcance.** Si el producto lo aborda, necesitará su
  equivalente nativo.

### Explícitamente no afectado

Camino de audio, `GC_QUEUE`, worker, retry, recovery, backend y el tag
`baseline-fea160c-android11-20260730`.

---

## 9. Fase C redefinida

El spike evalúa **un módulo nativo Android** que sea dueño de la sesión de
cámara y que:

- produzca periódicamente segmentos cerrados;
- entregue cada segmento a JavaScript;
- permita encolarlo de inmediato en `GC_QUEUE` vía `local_uri`;
- no modifique worker, retry, recovery ni backend;
- garantice segmentos reproducibles por separado **o** reconstruibles de forma
  determinista.

**Regla vigente del plan canónico:** el spike vive fuera del camino de
producción y su salida cumple el contrato `ChunkProducer` ya existente.

### Métricas obligatorias por pipeline

Ninguna se da por buena por lectura de código. Todas en dispositivo real:

Las asociaciones remiten a los criterios **literales** del plan canónico. Cuando
una métrica no corresponde a ningún criterio, se marca como tal en vez de
forzarla.

| Métrica | `C-AC` asociado | Título literal del criterio |
|---|---|---|
| Tiempo de cierre del segmento | C-AC1 | Primer fragmento durable remoto < 10 s |
| Tiempo desde GRABAR hasta el primer segmento cerrado | C-AC1 | Primer fragmento durable remoto < 10 s |
| **Tiempo hasta su confirmación remota** | **C-AC1** | Primer fragmento durable remoto < 10 s |
| Tiempo de reapertura del siguiente segmento | **C-AC4** | Sin huecos temporales silenciosos |
| Hueco audiovisual real, medido en **contenido perdido** | **C-AC4** | Sin huecos temporales silenciosos |
| Estabilidad del hash entre emisión y subida, y tras seguir grabando | C-AC3 | Orden e integridad verificables |
| Reproducibilidad independiente de cada segmento | C-AC7 | Segmentos reproducibles o muxing probado |
| Conservación y sincronía del audio en las fronteras | **C-AC9** | Audio conservado y sincronizado |
| Cierre forzado a 10 / 20 / 60 / 90 s | C-AC2 | Kill a 10 / 20 / 60 / 90 s |
| Pérdida del dispositivo — export desde otro dispositivo | C-AC5 | Export sin el dispositivo original |
| **Suite completa verde y sesión de audio medida antes y después** | **C-AC6** | Cero regresión del pipeline de audio |
| Reconstrucción del export y ensamblado | C-AC11 | Validez de concatenar bytes |
| Comportamiento cuando falta el segmento 0 | C-AC10 | Primer segmento vs segmentos posteriores |
| Apertura del export en reproductores estándar | C-AC8 | Export final reproducible |
| Background y pantalla bloqueada | **Sin criterio asociado** | métrica adicional del spike |
| Reinicio del dispositivo | **Sin criterio asociado** | métrica adicional del spike |
| Consumo de memoria | **Sin criterio asociado** | métrica adicional del spike |
| Complejidad y riesgo de integración | **Sin criterio asociado** | métrica adicional del spike |

> **`C-AC4` no se mide entre promesas ni entre llamadas de JavaScript.** Un
> hueco se mide en contenido ausente: fuente con cronómetro continuo en pantalla
> y señal sonora sincronizada, contando fotogramas y milisegundos de audio que
> faltan en la frontera.

### Condición eliminatoria

Un pipeline no es válido si **solo extrae bytes** y no permite recuperar
evidencia utilizable tras perder el dispositivo antes de pulsar PARAR.

---

## 10. Incógnitas abiertas

1. Si el segmento anterior queda **cerrado, completo y estable** al recibirse el
   evento de rotación. **Condición eliminatoria de P1.**
2. Qué precisión temporal se obtiene rotando por tamaño, y su dispersión con
   bitrate variable.
3. Cómo varía el comportamiento de `MediaRecorder` entre fabricantes.
4. Si el `MediaMuxer` de Android admite salida fMP4 sin dependencias externas.
5. Qué mecanismo de reconstrucción exige el export, y su coste. **Debe cerrarse
   antes de aprobar la arquitectura** (§7).
6. Si el comportamiento observado en `screenrecord` se reproduce en la ruta real
   — **sin resolver**, bloqueado hasta disponer de un APK depurable.
7. Qué duración de segmento equilibra latencia contra sobrecarga de peticiones.
   **No se fija aquí**: se decide midiendo.
