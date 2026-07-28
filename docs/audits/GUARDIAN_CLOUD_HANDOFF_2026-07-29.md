# Guardian Cloud — Handoff de sesión

**Fecha:** 2026-07-29
**Propósito:** traspaso de contexto a otra cuenta/sesión sin pérdida de estado.
**Este documento es autosuficiente.** No requiere la conversación previa.

> ⚠️ Este fichero **no forma parte del commit ratificado** y **no está en staging**. Es material de traspaso, no un informe de auditoría.

---

## 1. Identidad del proyecto

Guardian Cloud preserva evidencia **sacándola del dispositivo durante la grabación**.

- **Principio rector:** subir evidencia es más importante que conseguir una grabación perfecta.
- **Si no existe subida durante la grabación, el producto no cumple su propósito.** No es una degradación de calidad: es un incumplimiento.
- **`GC_QUEUE` es la fuente de verdad** local. Clave única `test.pending_retry` en AsyncStorage.
- **La UI no contiene lógica crítica.** Observa; no decide.

---

## 2. Estado real

La **auditoría documental del 2026-07-28 está cerrada y ratificada**.

### Veredicto vigente: `NO APTO`

**43 hallazgos:** `4 CRÍTICO / 10 ALTO / 17 MEDIO / 12 BAJO` (IDs `GC-AUD-001` … `GC-AUD-043`, sin huecos ni duplicados).

### Lo que funciona y lo que no

- **El audio tiene una base de supervivencia real.** Chunker en vivo cada 1,5 s, persistencia en disco antes de tocar la cola, worker single-flight, reintentos con backoff, puerta de finalización estricta, dedup y normalización. 138 tests de mobile en verde.
- **El vídeo NO protege durante la grabación.** Genera y encola el material **después** de detenerla (`mobile/app/index.tsx:5096` arranca el chunker sólo `if (recordingMode === 'audio')`; `mobile/src/recording/videoFileProducer.ts:77-79` declara que no toca el fichero durante la captura).
- **Ante kill, crash o pérdida del dispositivo mientras se graba vídeo puede perderse toda la evidencia.**

### Recovery — tres cosas distintas que no deben mezclarse

| ID | Capacidad | Estado |
|---|---|---|
| **I5a** | Normalización de cola **al arrancar la app** | **Verificada como lógica** (tests de rehidratación) |
| **I5b** | Recovery **físico tras kill** | **No demostrado** — requiere matar el proceso en un dispositivo y reabrir |
| **I5c** | Recovery **automático tras reiniciar el dispositivo, sin abrir la app** | **No implementado** — no hay receptor ni scheduler |

> **No confundir arranque de la app con reinicio del dispositivo.** Los logs `GC_BOOT_*` del código se refieren al arranque **de la app**. Esa ambigüedad es la que permitía leer `TEST_RESULTS.md:7` («Reboot mid-upload: PASS») como si el reinicio del dispositivo estuviera cubierto. No lo está.

### Reglas de honestidad del sistema

- **No declarar evidencia protegida cuando `uploadedCount = 0`.** Persistido localmente ≠ protegido: mientras no haya confirmación remota, perder el dispositivo implica perder esa evidencia. Texto exigido: «Todavía no protegido fuera del dispositivo».
- **`interrupted_kill` no puede inferirse** al encontrar una captura sin cierre. Encontrar una entrada abierta demuestra que no hubo cierre limpio, **nada más**. Usar `process_terminated` / `interrupted_unknown`. `interrupted_limit` e `interrupted_error` sólo con señal explícita. `user_stop` sólo si el grabador cerró y finalizó correctamente.
- **Android exige revisar los tipos de foreground service:** `microphone` (audio), `camera` + `microphone` (vídeo con audio), `dataSync` o mecanismo permitido (subida), junto con las restricciones de Android 15 — incluida la prohibición de arrancar `camera`, `microphone` o `dataSync` desde `BOOT_COMPLETED`.

---

## 3. Documentación desactualizada

**`docs/START_HERE.md` y `docs/IMPLEMENTATION_STATUS.md` todavía contienen afirmaciones retiradas** sobre validación, recovery y cumplimiento de la promesa central. Entre ellas:

- «El MVP core del sistema está validado» / «The system is no longer a prototype».
- «It has been validated under: app kill / network loss / background execution / recovery after restart».
- «Guardian Cloud fulfills its core promise: evidence survival under real conditions».
- «Recovery after device reboot» como capacidad existente.
- Cifrado local presentado como implementado (no existe: sólo un `TODO` en `mobile/app/index.tsx:541-542`).

**Estas afirmaciones no son fuente fiable hasta ejecutar A-0.** Los tres informes ratificados prevalecen sobre ellas.

---

## 4. Informes ratificados

| Informe | SHA-256 |
|---|---|
| `docs/audits/GUARDIAN_CLOUD_FULL_AUDIT_2026-07-28.md` | `1ba02281cf49ac6566172f89b0312586604e2a1a57fe3cf76dc75aa7621a17e1` |
| `docs/audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md` | `5080d09cbd88acaf8fe0c60c00c52c9315e0b9fbe125191c4d520ba54d64eaed` |
| `docs/audits/GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md` | `dce9dd91802fbcf0c6fc313c0001bd8b13d416f7b2270c38f8419fe1ea117905` |

**Commit de ratificación:** `e06682dbc7a31aeb00d9395a92f74f90a06aff68`
**Asunto:** `docs(audit): ratify Guardian Cloud 2026-07-28 audit`
**Autor:** `Diego <diego@diegoamaro.dev>`
**Committer:** `Diego Vázquez Amaro <amarosec@hotmail.com>` — identidad configurada en el repositorio; **no se modificó la configuración de git**, que no estaba autorizado.
**Sin trailers de coautoría.**

**Archivos contenidos en el commit — exactamente tres:**

```
docs/audits/GUARDIAN_CLOUD_FULL_AUDIT_2026-07-28.md
docs/audits/GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md
docs/audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md
```

`3 files changed, 1711 insertions(+)` — 1 070 + 329 + 312 líneas.

---

## 5. Estado de Git

- **Ruta del repositorio:** `D:\guardian-cloud` (`/d/guardian-cloud` en el shell POSIX)
- **Rama:** `main`
- **HEAD:** `e06682dbc7a31aeb00d9395a92f74f90a06aff68`
- **HEAD anterior al commit:** `dea0ed0f52e413b122a32cf43294c71150272b4e`
- **`origin/main`:** sigue en `dea0ed0f52e413b122a32cf43294c71150272b4e` → `main...origin/main [ahead 1]`

### `git status --short` tras el commit

```
 M mobile/app/index.tsx
 M mobile/app/settings.tsx
?? AGENTS.md
?? mobile/src/components/ReliabilityCard.tsx
?? mobile/src/permissions/notifications.ts
?? mobile/src/permissions/reliabilityDismissal.ts
```

### Cambios preexistentes que NO pertenecen a la auditoría

Estaban presentes al iniciar la sesión de auditoría y **no fueron tocados, incluidos, movidos ni descartados**. Su origen y contenido **no han sido identificados ni revisados** en esta sesión:

| Estado | Ruta |
|---|---|
| Modificado | `mobile/app/index.tsx` |
| Modificado | `mobile/app/settings.tsx` |
| Sin rastrear | `AGENTS.md` |
| Sin rastrear | `mobile/src/components/ReliabilityCard.tsx` |
| Sin rastrear | `mobile/src/permissions/notifications.ts` |
| Sin rastrear | `mobile/src/permissions/reliabilityDismissal.ts` |

> `AGENTS.md` es byte-idéntico a `CLAUDE.md` salvo la primera línea (título). Los otros cuatro parecen trabajo en curso sobre permisos y fiabilidad. **La cuenta nueva no debe limpiarlos, incluirlos ni modificarlos sin identificarlos antes con quien los creó.**

### Este handoff

`docs/audits/GUARDIAN_CLOUD_HANDOFF_2026-07-29.md` — **sin rastrear, fuera del commit y fuera del staging.**
No aparece en el `git status --short` anterior porque éste se capturó inmediatamente después del commit, antes de crear el fichero.

### Operaciones NO realizadas

**No hubo `push`, `tag`, `stash`, limpieza (`clean`/`reset`/`checkout --`) ni cambio de rama.** Se ejecutó un único `commit`. El trabajo permanece local.

> Nota: el commit se hizo sobre `main` por instrucción explícita, que prohibía cambiar de rama. La remediación **sí** debe ir en rama separada.

---

## 6. Próxima sesión

**La implementación debe comenzar en otra sesión y en una rama separada.**

Antes de tocar nada, la cuenta nueva debe:

1. **Leer:**
   - este handoff;
   - los tres informes ratificados;
   - `docs/START_HERE.md`;
   - `docs/IMPLEMENTATION_STATUS.md`;
   - `docs/ARCHITECTURE.md`;
   - `docs/API_SPEC.md`;
   - `docs/MVP_SCOPE.md`;
   - `docs/DESIGN.md`;
   - `docs/UI_SCREENS.md`.
2. **Tratar `START_HERE.md` e `IMPLEMENTATION_STATUS.md` como desactualizados** en los puntos contradichos por la auditoría.
3. **Verificar ruta, rama, `HEAD` y estado de Git.**
4. **No limpiar, incluir ni modificar los cambios preexistentes** del §5.
5. **Proponer** una rama de remediación creada desde el estado correcto de `main`, **pero no crearla** mientras existan cambios ajenos sin identificar.
6. **Empezar únicamente por A-0:**
   - añadir a `docs/START_HERE.md` y `docs/IMPLEMENTATION_STATUS.md` el aviso:
     `NO APTO — auditoría 2026-07-28; validación anterior retirada; vídeo no protege durante la grabación`;
   - enlazar los tres informes;
   - **no modificar código todavía.**
7. **Presentar el diff propuesto de A-0 y detenerse para aprobación.**

### Contexto del plan de remediación (fases)

`A` contención y verdad de producto · `B` baseline verde bajo el runtime de producción · `C` spike aislado de captura segmentada de vídeo · `D` integración del productor con `GC_QUEUE` · `E` semántica de captura interrumpida y recovery · `F` Android, OAuth, firma, NAS y seguridad de release · `G` validación física en build release con Metro apagado · `H` actualización documental posterior a evidencia real.

A-0 es el primer paso de la fase A. **No sustituye a la fase H**, que hará la reconciliación documental completa una vez exista evidencia física.

---

## 7. Reglas Git permanentes

- **Commit, push y tag requieren aprobaciones independientes e inmediatas.**
- **Una aprobación no se hereda** entre acciones ni entre sesiones.
- **Autor:** `Diego <diego@diegoamaro.dev>`.
- **Sin coautorías de IA.**
- **Nunca usar force-push.**
- **No mezclar cambios no relacionados.**

---

## 8. Prompt de reanudación

```
Lee completamente docs/audits/GUARDIAN_CLOUD_HANDOFF_2026-07-29.md y los tres informes
de auditoría que referencia. Reconstruye el estado real desde los archivos, no desde
afirmaciones históricas de validación. Verifica ruta, rama, HEAD y git status sin
modificar nada. Resume el veredicto, los invariantes, los bloqueos y el alcance exacto
de A-0. Propón el plan mínimo para A-0 y detente para aprobación. No implementes código,
no cambies de rama y no ejecutes commit, push, tag, stash, reset ni limpieza.
```

---

*Handoff generado el 2026-07-29 tras el commit `e06682d`. Fuera del commit y del staging.*
