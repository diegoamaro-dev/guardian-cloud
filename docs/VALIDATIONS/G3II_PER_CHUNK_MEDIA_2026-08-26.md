# G3'' — Contrato de medio por chunk · validación post-despliegue

## Identidad del gate

| | |
|---|---|
| **Gate** | `G3'' POST-DEPLOY FUNCTIONAL VALIDATION` |
| **Fecha** | 2026-08-26 |
| **Resultado** | **`PASS`** |
| **Alcance validado** | **exclusivamente `media='audio'`** |
| **session_id** | `28d9dcc3-08f2-46b5-9fcb-b476d555e222` |

> **El alcance de este PASS es literal.** No acredita `media='video'`, ni
> background, ni kill de la aplicación, ni pérdida de red, ni reinicio, ni el
> export final. Ninguno se ejecutó.

---

## Procedencia del artefacto validado

```
main                f3bb913161b7084ecbd756d9bf5b11bafb8f78e9
tree                e31b888beecde4dd2e70f794f888cf8a5c41c468
relación probada    tree(142c1f9) == tree(f3bb913)   — merge --no-ff sin cambio de contenido
APK sha256          36154ef8a8e6708cdb833d376aba452e50ec73127323681062d45155c543a025
backend             f3bb913, desplegado y en servicio
base de datos       migración 0005 aplicada · PostgREST reconoce la columna media
dispositivo         OnePlus A6000 · Android 11 · API 30
```

El APK se construyó desde un árbol de trabajo **limpio** cuyo objeto `tree` es
`e31b888b…`, verificado antes y después del build. Ese mismo objeto es el de
`142c1f9` y el del commit de integración `f3bb913`, de modo que **lo compilado
es, byte a byte, el contenido publicado en `main`**.

**Limitación del entorno, no del producto:** el reloj del dispositivo va en
**UTC-4**, seis horas por detrás del servidor. Toda marca de tiempo de origen
móvil que aparece en este documento está en esa referencia. Las marcas del
backend están en UTC.

---

## Resultado observado

### Dispositivo

```
chunks emitidos      17
chunks uploading     17
chunks uploaded      17
```

La simetría 17/17/17 significa que **cada chunk emitido se subió**, sin
reintentos, pausas ni entradas atascadas. La cola terminó en `entries: 0`.

### Backend

```
inserts de chunk               17
DRIVE_CHUNK_UPLOAD_SUCCESS     17
POST /complete                 200
errores level 40/50/60         0
manifiesto incremental         generado en el chunk 1 · actualizado en el 10
manifiesto final               17 chunks
```

### Base de datos

```
total            17        media_audio      17
media_video       0        media_null        0
media_invalido    0        uploaded         17
con_ref          17        idx_min           0
idx_max          16        idx_distintos    17
```

`idx_distintos = 17` con rango `0..16` descarta índices repetidos y huecos: no
hubo chunks perdidos ni duplicados.

### Manifiesto en Drive

```
schema                          "guardian-cloud.manifest.v2"
chunk_count                     17
manifest_seq                    17
chunks[].media == "audio"       17 / 17
mode   a nivel de raíz          AUSENTE
format a nivel de raíz          AUSENTE
```

`mode` y `format` no valen `null`: **no existen como claves**. Las claves de
nivel raíz observadas son `schema`, `session_id`, `destination_type`,
`created_at`, `completed_at`, `chunk_count`, `chunks`, `manifest_seq` y
`last_updated_at`. Cada entrada de `chunks[]` lleva `chunk_index`, `hash`,
`size`, `file_name` y `media`.

---

## Invariante principal — evidencia fuera del dispositivo durante la grabación

Marcas observadas, **hora del dispositivo (UTC-4)**:

```
18:16:31.688   startRecording  { mode: 'audio' }
18:16:42.860   chunk 0 subido
18:17:39.119   STOP_AND_UNLOAD_RETURNED
18:17:47.597   session completed
```

De ahí se sigue, por diferencia de marcas y no por inferencia:

- **hubo subida durante la grabación**;
- **15 chunks (0–14) estaban fuera del dispositivo antes de PARAR**;
- **el primer chunk quedó subido 56,3 s antes de PARAR**.

> Esto es evidencia **de esta ejecución**, con esta duración, en primer plano y
> con red estable. No es una afirmación general sobre todos los escenarios.

---

## Cadena de evidencia

### Observación directa

- logcat del PID de `com.guariacloud.app`, filtrado por PID en todas las lecturas;
- log del backend, correlacionado por `session_id`;
- las 17 filas de la tabla `chunks`;
- el manifiesto descargado desde Drive y releído sin modificarlo;
- captura de la pantalla final;
- confirmación del operador del estado visual durante la grabación.

### Deducción cerrada por código

Que el cuerpo de cada `POST /chunks` **contenía `media`**. Las 17 filas
almacenan `media='audio'` y el backend **no dispone de ningún otro camino para
poblar esa columna**: `insertChunk` escribe `media: input.media ?? null`, e
`input.media` procede exclusivamente del cuerpo validado de la petición. Un
cliente que no lo enviara habría producido `NULL`.

### No observado

- los bytes HTTP sobre el cable;
- la integridad de los ficheros de audio en Drive contra sus hashes;
- la reconstrucción o reproducción del audio;
- `media='video'`;
- background · kill · pérdida de red · reinicio · export.

---

## Los nueve criterios del protocolo

| # | criterio | resultado |
|---|---|---|
| 1 | arranca la grabación · UI en estado de grabación | `PASS` — ver nota |
| 2 | chunks en el log del PID correcto | `PASS` · 17 emitidos |
| 3 | el backend recibe `POST /chunks` del `session_id` | `PASS` · 17 inserts |
| 4 | `DRIVE_CHUNK_UPLOAD_SUCCESS` con `file_id` | `PASS` · 17 |
| 5 | al menos un chunk sube antes de PARAR | `PASS` · 15 chunks · margen 56,3 s |
| 6 | todos los chunks `media='audio'`, ninguno null | `PASS` · 17/17 · 0 null |
| 7 | `status='uploaded'` y `remote_reference` no vacío | `PASS` · 17/17 |
| 8 | el manifiesto cumple las cuatro condiciones | `PASS` · v2 · 17/17 · sin `mode` ni `format` |
| 9 | cero errores nuevos del camino validado | `PASS` · dispositivo 0 · backend 0 |

**Nota sobre el criterio 1.** El estado visual de grabación **no se capturó en
screenshot**: fue **observado por el operador**, que lo confirmó explícitamente.
El arranque funcional está además respaldado por evidencia independiente —
`GC_BACKGROUND_CALL_START_BEGIN { site: 'startRecording', mode: 'audio' }`
seguido de `ok: true`, y la producción efectiva de 17 chunks.

El criterio 9 se interpretó como **cero errores nuevos relacionados con
grabación, chunking, `GC_QUEUE`, persistencia, `POST /chunks`, subida a Drive o
generación del manifiesto**. No se observó ninguno.

---

## Congelado de evidencia

Dos copias verificadas, ambas presentes:

```
canónica   C:\Users\diego\gc-evidence\g3ii-2026-08-26\
espejo     /mnt/storage/evidence/g3ii-2026-08-26/
```

Siete ficheros idénticos en ambas ubicaciones:

| artefacto | SHA-256 |
|---|---|
| `28d9dcc3-08f2-46b5-9fcb-b476d555e222_manifest.json` | `3abba6bbc88385b477aaea762f554fc8697739e8ea5cc64a2cf8b32c8e9040e4` |
| `backend-log-28d9dcc3.txt` | `70e67b231c96b148642cdcccd391c7e534d80e37625433b66b725c5085e36f7b` |
| `db-chunks-28d9dcc3.csv` | `a025e0d990735db2472a1737060e1eb8a192531313a85cf5b9b7727c08baf68a` |
| `db-summary-28d9dcc3.csv` | `51d783626b76566abafdfcb6ab8924d892422558aaab4eb429ac60ada75aed72` |
| `device-logcat-28d9dcc3.txt` | `22aa1f3d61b7c9deb14e546f52b07e0528a3a90b8db71f825166c0d49845f655` |
| `screen-final.png` | `0eaeff8d23ea985043559630b677733e3ac14d0682138445c974a19f9e8eff7a` |
| `SHA256SUMS` | `2bcd61b17131c0c9dbd40aec374785a7838f0a90e162312bb826451f71fc502f` |

Constancia del procedimiento:

- **`SHA256SUMS` contiene seis entradas y no se incluye a sí mismo.**
- `sha256sum -c` pasó **6/6** con `exit=0`.
- Se realizó una **segunda comprobación independiente**, recalculando los
  digests y contrastándolos línea a línea contra el fichero.
- El contraste **Windows ↔ mini servidor** coincidió en **7/7**, incluido el
  hash del propio `SHA256SUMS`.

> **El espejo no es un backup independiente.** Reside en el mismo disco físico
> que otros datos del homelab, entre ellos el checkout del repositorio y el
> dump previo a la migración. Protege frente a borrado accidental de una copia,
> **no frente a fallo del disco**.

---

## Findings discovered during validation

Referencias nominales. **`DISCOVERED/OBSERVED — NOT REMEDIATED IN THIS GATE`.**

- `GC-OAUTH-SCHEME-COLLISION-001`
- `GC-OAUTH-NOSTATE-001`
- `GC-MANIFEST-BESTEFFORT-001`
- OAuth «Abriendo Google…» — refresco al recuperar el primer plano

Su descripción, evaluación y remediación corresponden a gates propios. **Este
documento no los desarrolla ni los corrige.**

> **`destinationResolved` no fue descubierto aquí.** Su semántica —un *race
> guard* que puede valer `true` sin destino conectado— ya estaba documentada
> desde el 2026-08-21 (`3fae4f6`) en
> [`KNOWN_LIMITS.md`](../KNOWN_LIMITS.md) §3. Esta validación lo observó
> **tres veces, siempre en su caso nominal**, con Drive conectado y sin
> ninguna pausa de destino. No reprodujo el caso previamente documentado de
> `destinationResolved: true` coexistiendo con Drive desconectado y una pausa
> de destino activa.

---

## Estado del dispositivo tras el gate

```
com.guardiancloud.app    REHABILITADA (pm enable --user 0)
com.guariacloud.app      habilitada, sin cambios
ambas                    habilitadas · datos conservados
ceDataInode  antigua     90164   (invariable antes y después)
ceDataInode  nueva       90434   (invariable antes y después)
```

Los `ceDataInode` invariables acreditan que **no se borró dato alguno**: un
`pm clear` o una reinstalación los habrían cambiado.

**`GC-OAUTH-SCHEME-COLLISION-001` vuelve a estar activo** por decisión
deliberada, al coexistir de nuevo dos aplicaciones que registran el mismo
scheme `guardiancloud://`. **No se ejecutó ningún flujo OAuth después de
rehabilitar la aplicación antigua.**
