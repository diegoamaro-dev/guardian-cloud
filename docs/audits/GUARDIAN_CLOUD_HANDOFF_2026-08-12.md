# Handoff — 2026-08-12

## 0. Siguiente tarea activa

**PRUEBA DE VÍDEO NATIVO desde aproximadamente 2 segundos.**
Todo lo demás de este documento está PENDIENTE y no debe iniciarse antes.

## 1. Resultado de las fases

| fase | veredicto | evidencia |
|------|-----------|-----------|
| S1 journal durable | PASS · CONGELADO | `guardian-cloud-evidence/p2/s1-journal-23d03a8/pass3/` |
| S2 adopción de segmentos | **FAIL** (criterio 3) | `.../p2/s2-adoption-23d03a8/` |
| S2b diagnóstico del cuello | PASS | `.../p2/s2b-fronteras/` |
| Incidente de observabilidad | CERRADO | ver §3 |

S2 demostró el puente completo —29/29 segmentos verificados extremo a extremo
contra Drive— y falló solo el criterio 3: al parar, 21 de 29 subidos frente a
los 27 exigidos. S2b localizó la causa: el coste por petición domina.

```
L (coste fijo)  = 2640,6 ms   IC95 [2474,9 – 2806,3]
T (rendimiento) = 0,35 MiB/s              R² = 0,9696
atraso B        = 3,76 segmentos/min · cierre→remote_ref +15,12 s/min
corrida C (6 s) = atraso 0,02 seg/min → plano
```

## 2. Estado del código

Sin commit ni push. Dos ficheros sin rastrear en `spike/s2-segment-adoption`
(base 23d03a8): `mobile/src/video/segmentAdopter.ts` y
`mobile/app/debug-p2-adopt/index.tsx`. `app/index.tsx`, GC_QUEUE, worker,
uploader, backend y el grabador P2 no fueron modificados.

## 3. Incidente de observabilidad del 12/08

Se perdió la salida observable en el log de PM2 durante aproximadamente
12 segundos de actividad confirmada por la BD. Ningún efecto observado sobre
entrega, metadata ni cierre: 50/50 chunks persistidos, sin huecos, sesión
cerrada a las 07:24:06.423Z. Causa exacta del reemplazo del proceso: DESCONOCIDA.

El log contiene una línea de 2997 bytes no textuales seguida de dos líneas ASCII
y una línea vacía. Esto explica su incompatibilidad con el parser JSON, pero no
identifica el emisor ni demuestra relación causal con el reemplazo del proceso.

## 4. Defectos descubiertos durante la investigación del incidente

1. La traza no es fiable como única fuente de auditoría: un proceso puede seguir
   sirviendo correctamente mientras su salida deja de registrarse.
2. La durabilidad de la metadata depende de una segunda petición dirigida por el
   cliente (`POST /chunks`); la primera solo sube bytes y no persiste nada.
3. `POST /complete` no es idempotente para el cliente: si persiste y se pierde la
   respuesta, el reintento recibe 409.
4. `chunk_count` cuenta las filas existentes en ese instante; el backend no conoce
   ningún total esperado y puede cerrar una sesión incompleta sin error.

### Hallazgos previos o paralelos (no causados por este incidente)

5. Sin redundancia local entre sesiones: el grabador vacía `cacheDir/gc-p2-gate`
   al iniciar cada captura y el worker borra la copia estable tras confirmar.
6. Integridad de bytes en Drive no verificable sin descargar: el backend nunca
   pide ni guarda `md5Checksum`.
7. 16 % de `total_ms` sin atribuir. `REMOTE_INTERNAL_SPLIT` sigue sin cerrarse.
8. `DOCUMENTATION_DRIFT = CONFIRMED` en `docs/API_SPEC.md:82` y `:100`.

## 5. Plan de remediación — PENDIENTE DE APROBACIÓN

Orden acordado: **C1 mínimo → B → A**. C2 va aparte y no bloquea nada.

### C1 · Observabilidad mínima

`process_instance_id`: identificador aleatorio nuevo en cada arranque del proceso.
No se usa el término «boot_id» hasta decidir si designa proceso o host.
Añadir además `pid` y correlacionar `reqId` entre subida, persistencia, respuesta
y cierre. Detectar huecos y escritura no JSON en el canal estructurado.
Nunca UUID completos, `remote_reference`, URL, tokens, hashes ni contenido.
Ficheros: `backend/src/utils/logger.ts`, `backend/src/app.ts`, rutas que loguean.
Sin migración.

### B · Cierre idempotente

Repetir `POST /complete` sobre una sesión ya completada devuelve éxito equivalente
en lugar de 409. Se acepta un total esperado del cliente y se impide el cierre si
faltan índices. Compatibilidad: sin ese campo, comportamiento actual.

**DECISIÓN PENDIENTE — `expected_chunk_count`:**

- *validar sin persistir*: sin migración ni cambio de esquema, sin estado; pero el
  total no queda auditable después y un reintento puede enviar un número distinto
  sin que nada lo detecte;
- *persistirlo*: permite comprobar idempotencia contra el mismo valor y auditar a
  posteriori; cuesta una migración y una columna nullable que las sesiones
  antiguas no tendrán.

No se elige aquí. La migración NO está aprobada.

Ficheros: `backend/src/services/sessions.service.ts`,
`backend/src/routes/sessions.routes.ts`, `backend/src/schemas/sessions.schema.ts`,
`mobile/app/index.tsx`.

### A · Consistencia de entrega

Objetivo: **una única operación desde la perspectiva del cliente, coordinada por el
backend, con persistencia antes de confirmar y reconciliación para el caso Drive
correcto + BD fallida.** No es una operación atómica entre Drive y Supabase, y no
debe describirse como tal.

Conserva las dos capas de deduplicación y el recovery. GC_QUEUE no marca `uploaded`
hasta recibir confirmación durable.

Efecto medible afirmable: elimina una segunda petición del cliente y procesamiento
duplicado. **Pendiente de medición**; no se le atribuye ninguna cifra de ahorro.

**HIPÓTESIS PENDIENTE DE PRUEBA:** que un fichero presente en Drive sin fila en BD
pueda reconciliarse completamente a partir de su nombre determinista.

Ficheros: `backend/src/routes/destinations.routes.ts`,
`backend/src/services/chunks.service.ts`, `mobile/app/index.tsx`,
`mobile/src/api/destinations.ts`. Sin migración.

### C2 · Posterior, separado

Separación del canal estructurado y reconciliación periódica BD ↔ eventos, con la
BD como fuente de verdad y los eventos solo como explicación.

## 6. Pruebas obligatorias para cualquiera de los tres bloques

Mala red · kill app · caída entre Drive y BD · respuesta perdida · replay ·
background · reinicio.

## 7. Despliegue

`DEPLOYMENT_MECHANISM_TO_VERIFY`. El homelab no tiene `dist/` y no se conoce el
comando real con el que PM2 arranca el backend. No se documenta ningún
procedimiento hasta verificarlo.

## 8. Estado bloqueado

```
S3                     BLOCKED
IMPLEMENTATION_CHANGES NOT_AUTHORIZED
REMOTE_INTERNAL_SPLIT  NOT_OBSERVABLE (16 % sin atribuir)
```
