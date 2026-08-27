# `GC-MANIFEST-BESTEFFORT-001` · ARMA B — validación de la consecuencia H4

## Identidad del ensayo

| | |
|---|---|
| **Ensayo** | `GC-MANIFEST-BESTEFFORT-001 · ARMA B` |
| **Fecha** | 2026-08-27 |
| **Resultado** | **`H4_RESULT = PASS`** |
| **Alcance validado** | **exclusivamente la consecuencia H4** |
| **Hipótesis asociada** | `GC-MANIFEST-BESTEFFORT-001` |
| **session_id del ensayo** | `6c4d78a0-0644-4d34-b139-8c108e78b881` |
| **session_id de control** | `df401b5b-3429-42d4-98ea-5dfab60a56c4` |

> **Qué significa `PASS` aquí.** Significa que **el ensayo se ejecutó
> correctamente y produjo evidencia suficiente para validar la consecuencia
> H4**. **No** significa que el comportamiento del producto sea correcto, ni
> que sea aceptable para release, ni que el finding esté resuelto.

> **Este documento registra evidencia; no clasifica el finding.** La
> promoción, clasificación y remediación de `GC-MANIFEST-BESTEFFORT-001`
> corresponden a su gate propio. Aquí no se le asigna estado canónico.

---

## Hipótesis sometida a prueba

```
H4  Una Protection Session puede:
      · subir correctamente TODOS sus chunks,
      · conservar en Drive su último manifiesto INCREMENTAL,
      · completar sin ninguna señal de error al cliente,
      · fallar ÚNICAMENTE al escribir el manifiesto FINAL,
    y aparecer después en recovery como una representación PARCIAL
    de una sesión que en realidad está completa.
```

H1 y H2 —invisibilidad total de una sesión sin ningún manifiesto— **no se
sometieron a prueba en este ensayo**.

---

## Procedencia

```
backend desplegado   f3bb913161b7084ecbd756d9bf5b11bafb8f78e9
                     el árbol `backend/` de f3bb913 y el de 8d00196 son el
                     mismo objeto Git (tree 30055a2d…): el desfase entre el
                     checkout desplegado y `main` es exclusivamente documental
dispositivo          OnePlus A6000 · Android 11 · API 30
aplicación           com.guariacloud.app · PID 28201 · identidad a1b40cd3…
destino              Google Drive conectado · carpeta /GuardianCloud
```

**Limitación del entorno, no del producto:** el reloj del dispositivo va en
**UTC-4**. Las marcas de origen móvil de este documento están en esa
referencia; las del backend, en UTC.

---

## Procedimiento

Se introdujo una **instrumentación temporal, no versionada**, en
`backend/src/services/manifest.service.ts`, retirada íntegramente al terminar:

```
punto de inyección   al principio del callback de withDriveRetry dentro de
                     tryGenerateManifest, ANTES de ensureRootFolder y de
                     uploadOrReplaceFile
condición            session.id EXACTAMENTE igual al UUID de un fichero de
                     activación situado FUERA del repositorio
fail-closed          fichero ausente, vacío, multilínea, >64 bytes o con un
                     UUID no canónico  →  NO inyecta
camino incremental   LITERALMENTE INTACTO
efecto               un Error sintético que entra por el `catch` productivo ya
                     existente y produce la misma clasificación observable que
                     un fallo real de Drive: GC_MANIFEST_FAILED con
                     reason='drive_upload_failed'
```

Antes de armar se comprobó, sobre el fichero de activación real, que **sólo
casaba la sesión del ensayo**: no casaban la sesión histórica de `G3''`, un
UUID que difería en el último carácter, un prefijo truncado ni el UUID nulo.

El fallo se armó **con la grabación ya en curso**, después de observar 64
escrituras incrementales correctas. La instrumentación no modificaba el camino
incremental y su condición por `session_id` exacto acotaba la inyección
exclusivamente a la sesión del ensayo.

---

## Resultado observado

### Dispositivo

```
inicio               09:16:10.630
primer chunk subido  09:16:21.420      → 10,8 s después, con la sesión abierta
PARAR                09:58:05.354
/complete            09:58:12.995
session completed    09:58:14.498
cola vacía           09:58:14.444   entries: 0

emitted / uploaded   635 / 635        fallos de chunk   0
```

### Backend

```
insertChunk                         635
DRIVE_CHUNK_UPLOAD_SUCCESS          635
GC_INCREMENTAL_MANIFEST_GENERATED    64      (chunk_count 1, 10, 20 … 630)
GC_MANIFEST_FAILED                    1      reason 'drive_upload_failed'
                                             err   GC_FAULT_INJECTION_FINAL_MANIFEST
GC_MANIFEST_GENERATED                 0      para esta sesión
GC_INCREMENTAL_MANIFEST_FAILED        0
eventos de fallo de OTRAS sesiones    0
POST /complete                      200      sin señal de error al cliente
```

Los 64 incrementales son el número exacto: `1` más los 63 múltiplos de 10
desde 10 hasta 630. Los 64 escribieron **el mismo `file_id`**
`1nC-RgXVOpujEPpmkkTfvnQ5xSzDTpoDe`, lo que acredita que
`uploadOrReplaceFile` sobrescribió **un único fichero** y no acumuló
duplicados.

### Base de datos — fuente autoritativa

```
total            635        uploaded              635
con remote_reference   635  media = audio         635
idx_min            0        idx_max               634
idx_distintos    635        índices ausentes en 0..634   ninguno
```

### Manifiesto real descargado de Drive

Objeto descargado por `file_id` con `alt=media` —**no reconstruido
localmente**—, `157 731` bytes:

```
schema             "guardian-cloud.manifest.v2"
session_id         6c4d78a0-0644-4d34-b139-8c108e78b881
is_partial         true
completed_at       null
chunk_count        630        manifest_seq   630
chunks[]           630 entradas · índices 0..629 · media "audio" en las 630
file_id            1nC-RgXVOpujEPpmkkTfvnQ5xSzDTpoDe
```

### Recovery

```
session_id          6c4d78a0-0644-4d34-b139-8c108e78b881
protection_status   "partial"
completed_at        null
chunk_count         630
manifest_file_id    1nC-RgXVOpujEPpmkkTfvnQ5xSzDTpoDe
```

---

## La afirmación central

> **635 chunks fueron subidos y registrados de forma continua (0..634); el
> manifiesto incremental superviviente representa únicamente 630 (0..629). Los
> chunks 630..634 están subidos y registrados, pero quedan fuera del manifiesto
> parcial.**

Una sesión **completada** —`/complete` respondió `200` y la cola quedó
vacía— figura en recovery como **parcial**, con `completed_at` nulo y cinco
chunks menos de los que existen. El cliente no recibió ninguna señal.

---

## Rollback

La instrumentación se retiró y su retirada se demostró **funcionalmente**, no
sólo en disco:

```
desarme            fichero de activación borrado
restauración       git checkout -- backend/src/services/manifest.service.ts
                   sha256 409d0221039cc8a588e3446d25ca6d309cb7a1d9d93d896f59619de61fdcdacf
                   idéntico al snapshot previo a instrumentar → byte a byte
disco              worktree limpio · GC_FAULT en backend/src = 0
recarga forzada    touch backend/src/index.ts
                   hijo de tsx watch 2562998 → 2596564 · uptime_s reiniciado a 19
                   PM2 online
```

**Prueba funcional** — sesión de control `df401b5b-3429-42d4-98ea-5dfab60a56c4`,
22 chunks, 86 s:

```
GC_INCREMENTAL_MANIFEST_GENERATED   chunk_count 1, 10, 20
GC_MANIFEST_GENERATED               chunk_count 22   ← el camino FINAL funciona
GC_MANIFEST_FAILED                  0
GC_FAULT_INJECTION_FINAL_MANIFEST   0
recovery                            "complete" · completed_at no nulo
manifiesto                          1 fichero · file_id 1bBvuO47vIS81_qAz4J6kP70zXNUC4ceE
```

**La evidencia del ensayo permaneció inalterada durante el control**: la
sesión `6c4d78a0…` siguió en `partial`, con `chunk_count` 630, `completed_at`
nulo y el mismo `manifest_file_id`. Drive pasó de 68 a 69 manifiestos y
recovery de 63 a 64 sesiones — exactamente el incremento de la sesión de
control, sin tocar nada previo.

El único evento de fallo de toda la ventana se atribuyó por `session_id`:
pertenece **exclusivamente** a la sesión del ensayo.

---

## Congelado de evidencia

Dos copias verificadas, **19 artefactos** cada una:

```
canónica   /home/diego/gc-evidence/manifest-armb-2026-08-27/
espejo     C:\Users\diego\gc-evidence\manifest-armb-2026-08-27\
```

`sha256sum -c SHA256SUMS` devolvió **`exit 0` con 19 entradas y 0 fallidas en
ambas ubicaciones**, y el hash del propio índice coincide en las dos.

```
ANCLA VÁLIDA — sha256 de SHA256SUMS
6f2af56468cc15e1c498a5fdef68e5934fd727c20a3defbe605b8f646eb8a601
```

Hashes verificados individualmente durante la captura:

| artefacto | SHA-256 |
|---|---|
| `device-logcat-6c4d78a0-….txt` | `f5720a3e62637d3245764f0365142211218ee0c27da3367dc39a86409e2e00f9` |
| `backend-log-6c4d78a0-….txt` | `ca7c07550e790a362b451a6a95b3508f3483ec39870e565ff6663bc024db128d` |
| `fault-file-6c4d78a0-….uuid` | `e85d8bedf36aa7a4fef183d1ca6d3e9b076f44e30700a8b9bc2df57ca8922cb1` |
| `instrumentation.diff` | `7538f8378200c78ee83af13d1be9041d9e7cd01c6707f1bf73bde7bcc9e02f25` |

> **Un índice anterior quedó INVALIDADO.** El primer `SHA256SUMS` generado
> —hash `a1dd80aa…`— contenía **20 entradas en lugar de 19** porque el fichero
> temporal de generación se creaba dentro del propio directorio y acababa
> autoincluyéndose; además, su recuento de verificación dependía del idioma de
> `sha256sum`, que en este sistema imprime `La suma coincide` y no `OK`. El
> índice se regeneró construyendo la lista y el fichero **fuera** del
> directorio, excluyendo explícitamente `SHA256SUMS` y cualquier temporal, y
> aceptando por **código de salida** con `LC_ALL=C`. **`a1dd80aa…` no debe
> usarse como hash válido en ninguna parte.**

> **El espejo no es un backup independiente.** La copia canónica reside en el
> mismo disco que el checkout del repositorio y otros datos del homelab.
> Protege frente al borrado accidental de una copia, **no frente al fallo del
> disco**.

---

## Estado

```
consecuencia sometida a prueba en H4      VALIDADA EN HARDWARE
H1 / H2 — invisibilidad total             NO VALIDADAS
ARMA A                                    NO EJECUTADA · aparcada
                                          (DESIGN REVISION REQUIRED)
remediación                               NO INICIADA
impacto sobre release                     NO DECIDIDO POR H4
Guardian Cloud                            NO APTO PARA RELEASE — sin cambio
```

H4 demuestra que **la consecuencia existe**. No dice con qué frecuencia la
produciría un fallo real de Drive: eso exigiría un ensayo distinto, sobre
modos de fallo naturales y no sobre inyección.

---

## Lo que este ensayo NO acredita

```
· que los 635 chunks sean recuperables mediante el manifiesto parcial
· que se haya perdido evidencia — los bytes están en Drive y en la base de datos
· que el manifiesto parcial esté corrupto — es válido, sólo incompleto
· que una sesión sin ningún manifiesto quede invisible (H1/H2)
· la probabilidad de que esto ocurra en producción
· que la recuperación cross-device esté validada
· que el runtime recargue de forma fiable ante un cambio en `src/`
· nada sobre `media='video'`, background, kill, pérdida de red, reinicio
  ni export final
```

---

## Findings adyacentes — **fuera del alcance de este documento**

Referencias **nominales**. Este registro no los desarrolla, no los clasifica,
no los promueve y no extrae conclusiones sobre ellos.

- `GC-DEPLOY-RELOAD-001`
- `GC-DB-LIST-LIMIT-001`
- `GC-STORAGE-NAMING-001`
- `GC-OAUTH-SCHEME-COLLISION-001`
- `GC-OAUTH-NOSTATE-001`
