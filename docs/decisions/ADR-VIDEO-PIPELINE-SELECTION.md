# ADR — Selección de pipeline de segmentación de vídeo

| | |
|---|---|
| **Estado** | Pipeline candidato **seleccionado**. Aprobación **condicionada** a los once `C-AC` |
| **Fecha** | 2026-07-30 |
| **Decide** | Propietario del producto |
| **Refina a** | [`ADR-VIDEO-NATIVE-SEGMENTATION`](./ADR-VIDEO-NATIVE-SEGMENTATION.md) |
| **Afecta a** | `GC-AUD-001`, fase C y D del plan de remediación 2026-07-28 |

---

## Veredicto

```
Decisión previa (no se revoca): segmentación nativa obligatoria.

P1 · Camera2 + MediaRecorder.setNextOutputFile
     → experimento observacional OPCIONAL
     → NO apto como arquitectura de producción

P2 · Camera2 + MediaCodec + MediaMuxer
     → pipeline candidato para el spike Y candidato de producción
     → NO es arquitectura validada
     → aprobación definitiva condicionada a los once C-AC
```

El ADR anterior declaraba el pipeline concreto «pendiente del spike P1/P2». Este
documento resuelve esa incógnita. **La decisión de segmentación nativa
obligatoria no cambia.**

---

## 1. Resolución de `E11`

`E11` preguntaba si existe un punto soportado y verificable, **durante la
grabación**, en el que el segmento anterior sea seguro para leer, hashear,
encolar y subir.

**Queda resuelta por la documentación pública de Android, no por medición.**

La API de `setNextOutputFile(FileDescriptor)` indica que la aplicación no debe
utilizar el fichero referenciado hasta `stop()`, aunque el descriptor pueda
cerrarse al retornar la llamada. `MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED`
confirma el cambio de salida, pero **no documenta que el fichero anterior pueda
leerse y distribuirse durante la sesión**.

> **`E11` se confirma para P1.** No existe un punto contractualmente soportado
> para utilizar y subir los segmentos antes de `stop()`.

Esto es independiente de lo que se observe en dispositivo. Un hash estable en un
modelo concreto no convierte un comportamiento no documentado en una garantía:
una actualización de Android, otro fabricante o una condición de carga distinta
pueden invalidarlo sin aviso previo y sin que ninguna prueba propia lo hubiera
anticipado.

## 2. Reclasificación de P1

**P1 es un experimento observacional opcional.**

Ejecutarlo **ya no puede terminar en «P1 aprobado»**. Sus únicos resultados
posibles son una caracterización del comportamiento real de `MediaRecorder`, o
una decisión de producto que acepte de forma explícita y documentada
comportamiento no garantizado por la plataforma.

**No se ejecutará antes de P2** salvo que exista un objetivo concreto de
caracterización que justifique su coste.

## 3. Selección condicionada de P2

**P2 — `Camera2` + `MediaCodec` + `MediaMuxer`** se selecciona como **pipeline
candidato para el spike y candidato de producción**.

> **No es una arquitectura validada.** Ningún criterio `C-AC` está superado. La
> aprobación definitiva sigue condicionada a los once criterios del plan
> canónico de remediación 2026-07-28.

### Fundamento contractual

En P2, el cierre de cada segmento ocurre cuando **nuestro código** llama a
`MediaMuxer.stop()`. **Tras esa llamada, el segmento puede utilizarse conforme
al contrato público de Android.**

La diferencia con P1 no es que el contrato sea «propio» — sigue siendo el de la
plataforma. La diferencia es que el punto de cierre está **controlado por nuestro
código y soportado por la API**, en lugar de inferirse de un evento cuyo
contrato dice explícitamente lo contrario.

---

## 4. Puerta temprana

Antes de construir nada más:

```
Una sesión continua con una rotación que produzca dos MP4 cerrados e
independientes.

Ambos deben:
- abrir en reproductor real;
- contener vídeo y audio;
- incluir configuración de códec válida;
- comenzar el vídeo en keyframe;
- conservar sincronía A/V;
- presentar timestamps válidos.

Además, debe medirse el contenido perdido o duplicado en la frontera.
```

Esta puerta ejercita de golpe los tres riesgos serios de P2 —sincronía A/V,
alineación con keyframe y configuración de códec por segmento— antes de invertir
en el resto. Si no se supera, la conversación cambia sin haber gastado semanas.

### Regla de rotación

**La rotación no debe depender de que la solicitud de keyframe sea obedecida
inmediatamente.**

```
1. Se solicita el keyframe.
2. Se ESPERA a recibir un buffer marcado como keyframe.
3. Ese buffer abre el siguiente muxer.
4. Si no llega dentro del límite definido:
       la rotación FALLA DE FORMA VISIBLE.
```

**Nunca se crea silenciosamente un segmento indecodificable.** Un fallo visible
de rotación es recuperable y diagnosticable; un segmento que aparenta ser válido
y no lo es contamina la evidencia y no se detecta hasta el export.

---

## 5. Partes reutilizadas del plan de pruebas

Aproximadamente el **80 %** del plan preparado para P1 sobrevive.

| Pieza | Reutilización |
|---|---|
| Cierre real (V1–V6) | **Íntegra.** En P2 pasa de comprobar a un tercero a autoverificar nuestro propio muxer |
| Barrido de parámetros de segmento | **Íntegra y más simple.** P2 rota por tiempo, así que la duración es directa |
| Prueba prolongada de ≥500 rotaciones | **Íntegra.** El criterio de fiabilidad no depende del pipeline |
| Medición de huecos: cronómetro visual + tono de 1 kHz, midiendo **contenido perdido** | **Íntegra, sin cambios** |
| Terminación T1–T5, incluida la corrección de T2 y el registro de relanzamiento de PID | **Íntegra** |
| Matriz de aceptación `C-AC1…C-AC11` | **Íntegra.** No depende del pipeline |
| Riesgos `E3`, `E4`, `E5`, `E6`, `E8` | **Se mantienen** |

**No se reutiliza:** la instrumentación de `MAX_FILESIZE_APPROACHING` /
`REACHED`, el barrido de retardos artificiales, y las condiciones `E1`, `E2`,
`E7`, `E9`, `E10` y `E11` en su formulación actual.

### Corrección sobre R1/R2/R3

**Se reutilizan la estrategia y las pruebas, NO el mecanismo actual de
exportación.**

El export vigente reconstruye concatenando el prefijo contiguo de bytes, válido
para AAC ADTS por ser auto-delimitado. **Los MP4 independientes que produce P2
no pueden concatenarse como bytes.**

Para producir un único archivo, **P2 necesitará remux** —en dispositivo o en
backend—. Lo que se hereda del plan es el marco de decisión y sus pruebas de
verificación, no la implementación existente.

| | Estrategia | Estado en P2 |
|---|---|---|
| **R1** | Retención mínima de clips independientes | Suelo. **No demuestra export final usable ni aprueba `C-AC8` ni `C-AC11`** |
| **R2** | **Remux en dispositivo** con `MediaExtractor` + `MediaMuxer` | **Requisito para aprobar P2**, salvo decisión de producto que cambie formalmente el contrato de exportación |
| **R3** | Remux en backend | Alternativa si R2 no resulta viable. Implica cambios de backend, hoy fuera de alcance |

---

## 6. Riesgos que P2 elimina

| Riesgo de P1 | Por qué desaparece |
|---|---|
| **`E11`** · sin punto contractual | El cierre lo provoca `MediaMuxer.stop()` desde nuestro código, y tras esa llamada el uso del segmento está soportado por la API pública |
| **`E1`** · ¿está cerrado el anterior? | Determinista. No se infiere de un evento ajeno |
| **`E2`** · estabilidad del hash | Cuando el muxer deja de escribir, el fichero es final. Ningún fabricante lo parchea después |
| **`E7`** · toma de cámara | No interviene `MediaRecorder` |
| **`E9`** · margen de rotación | No existe ventana `approaching → reached` |
| **`E4`** · dispersión temporal | **Se reduce mucho.** La rotación por tiempo hace la latencia directamente configurable en vez de derivarla del bitrate. Mejora sustancial para `C-AC1` |
| **`E8`** · variación entre fabricantes | **Se reduce, no desaparece.** Se deja de depender de la implementación de `MediaRecorder` de cada OEM; `Camera2`, `MediaCodec` y los encoders siguen variando |

## 7. Riesgos nuevos que P2 introduce

| # | Riesgo | Por qué es serio |
|---|---|---|
| **N1** | **Sincronía A/V propia.** Capturar con `AudioRecord`, codificar a AAC y alinear timestamps a través de las fronteras | `MediaRecorder` lo hacía por nosotros. Es la parte clásicamente difícil. `C-AC9` la mide |
| **N2** | **Alineación con keyframe.** Cada segmento debe empezar en IDR | Si empieza a mitad de GOP, `C-AC7` falla. Mitigado por la regla de rotación de §4 |
| **N3** | **Configuración de códec por segmento.** SPS/PPS (`csd-0`, `csd-1`) en **cada** muxer | Omitirlo produce segmentos indecodificables que aparentan estar bien |
| **N4** | **Fotogramas en vuelo al rotar** | Descartarlos abre hueco (`C-AC4`); desordenarlos corrompe |
| **N5** | **Rarezas de `MediaCodec`**: formatos de color, entrada por superficie, semántica de `flush` | Varía entre fabricantes tanto o más que `MediaRecorder` |
| **N6** | **Coste y latencia de resultados** | Es el pipeline más caro. Pasará más tiempo hasta la primera medición |
| **N7** | **Batería y térmica** | Difícilmente igualará la optimización de `MediaRecorder`. Afecta a grabaciones largas |
| **N8** | **Ciclo de vida y orientación** | Rotación del dispositivo y metadatos pasan a ser responsabilidad propia |

> **Balance.** P2 elimina los riesgos que **impedían aprobar** y añade riesgos
> que **encarecen y pueden retrasar**. Cambia riesgo de viabilidad por riesgo de
> ejecución. Es el intercambio correcto para un producto de evidencia, pero no
> es una mejora gratuita.

---

## 8. Consecuencia provisional para API 24–25

P2 utiliza APIs disponibles desde **API 24**. Eso resuelve la cuestión **en
cuanto a disponibilidad de las APIs necesarias**.

> **No se declara compatibilidad validada.** Disponibilidad de API no es
> funcionamiento demostrado: los encoders, `Camera2` y el comportamiento de
> `MediaCodec` en Android 7.0/7.1 no se han probado.

**La eliminación definitiva del fallback y de la opción de elevar `minSdk` a 26
queda condicionada** a que la puerta temprana y las pruebas posteriores pasen
**en API 24–25**.

Estado provisional de las tres opciones del ADR anterior:

| Opción | Estado |
|---|---|
| **A · Elevar `minSdk` a 26** | **Provisionalmente innecesaria.** Se reabre si P2 no funciona en API 24–25 |
| **B · Deshabilitar el modo vídeo en API 24–25** | **Provisionalmente innecesaria.** Sigue vigente su regla: no existe «vídeo menos protegido»; o cumple el contrato o se deshabilita declarando incompatibilidad |
| **C · Segundo pipeline como fallback** | **Provisionalmente descartada.** P2 cubre todo el rango con un solo pipeline |

---

## 9. Impacto futuro sobre exportación y documentación

### Exportación

**El export tendrá que cambiar.** No es opcional ni ajeno a la integración: los
MP4 independientes no se concatenan como bytes, y `C-AC8` y `C-AC11` solo se
aprueban con un mecanismo de remux demostrado.

Debe responderse, con demostración, **antes de aprobar la arquitectura**:

1. ¿R2 en dispositivo, o R3 en backend?
2. ¿Qué obtiene el usuario si faltan segmentos intermedios?
3. ¿Qué obtiene si falta el segmento 0? `C-AC10` exige que el sistema **lo
   declare**, nunca corrupción silenciosa ni falso éxito.
4. ¿El resultado se abre en reproductores estándar? `C-AC8`.

La *implementación* puede ir después; la **estrategia verificable, no**.

### Documentación

Cuando P2 supere o no la puerta temprana, habrá que actualizar:

- `IMPLEMENTATION_STATUS.md` — la tabla canónica de tres niveles, donde el vídeo
  segmentado, su subida durante la grabación, su recuperación y el export `.mp4`
  siguen en **nivel 3: planificado, no implementado ni validado**;
- `KNOWN_DEBT.md` — la deuda del `moov` en exports parciales cambia de naturaleza
  con segmentos cerrados;
- `RELEASE_CHECKLIST_v0.3.md` — si el modo vídeo llega a ser liberable.

**Nada de eso se toca ahora.** El nivel 3 sigue siendo correcto: seleccionar un
pipeline candidato no implementa nada.

---

## 10. Lo que este ADR no hace

- **No revoca** la decisión de segmentación nativa obligatoria.
- **No aprueba** P2 como arquitectura de producción.
- **No declara** compatibilidad con API 24–25.
- **No levanta** el veredicto `NO APTO` de la auditoría 2026-07-28.
  `GC-AUD-001` sigue abierto.
- **No implementa** nada, ni añade dependencias, ni modifica código.
