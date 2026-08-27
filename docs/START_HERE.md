# Guardian Cloud — START HERE

⛔ NO APTO PARA RELEASE — por cifrado local, recovery `I5c`, export `.mp4`, cobertura de dispositivos **y findings de identidad/destino todavía no cerrados**. **Ya no por `GC-AUD-001`.**

Este documento contiene referencias históricas que deben leerse con la fecha y
el alcance de su evidencia. El estado vigente se reconstruye desde:

* [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica),
  referencia canónica del estado por capacidad;
* [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) — límites y findings vigentes;
* [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md) §0 — invariante de
  migración de identidad, **bloqueante**;
* [validación física del vídeo nativo con durable cleanup del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md);
* [validación física de la integración nativa segmentada del 13/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md).

> **Lee esto antes que nada.** Entre el 21/08 y el 24/08 aparecieron ocho
> findings de identidad, destino y herramientas de desarrollo. **Uno está
> `CLOSED IN HARDWARE`**; los demás permanecen corregidos o abiertos con
> distintos niveles de validación, y **la tabla canónica define el estado
> exacto de cada uno**. Todo lo que este documento
> describe como validado el 20/08 sigue siendo cierto, pero **no cubre nada de
> ese bloque**. La tabla completa está en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#findings-abiertos-de-identidad-destino-y-herramientas).

### Lo que cambió el 2026-08-20

El requisito crítico del producto quedó **demostrado físicamente**: la evidencia
de vídeo sale del dispositivo **durante** la grabación. Primera subida
confirmada a `+14,619 s`, PARAR a `+75,514 s`, margen de `60,895 s`, con 11 de
12 chunks confirmados antes de detener la captura.

`GC-AUD-001` **deja de ser un defecto vigente**. Las afirmaciones de este
repositorio que digan que el vídeo sólo se encola después de parar describen la
baseline `v0.3.0-rc.1`, no la rama actual.

### Punto de partida actual (2026-08-20)

* **Native segmented recording:** `HARDWARE_VALIDATED` en OnePlus A6000 /
  Android 11 / API 30 / `arm64-v8a`.
* **Subida de vídeo durante la captura:** `HARDWARE_VALIDATED`.
* **Durable cleanup/scheduler, ruta normal:** `HARDWARE_VALIDATED`.
* **Recovery de una sesión pendiente tras restaurar Drive:**
  `HARDWARE_VALIDATED`.
* **Frontera de borrado exclusiva por journal:** `HARDWARE_VALIDATED` mediante
  prueba dirigida con directorios centinela — `authorized → eligible`,
  `no journal → invisible`.
* **Rutas artificiales de fallo del scheduler:** `HARDWARE_HARDENING_PENDING`.
  No bloquean la integración de la rama; **no queda ningún gate bloqueante del
  Escenario 17**.
* **Validación automática de aquel corte:** 360/360 tests. *(Cifra histórica del
  20/08. La vigente está más abajo.)*

### Validación automática (2026-08-27, sobre `main@63099d8`)

| Comprobación | Resultado |
|---|---|
| Suite **móvil** (`mobile/`) | **936/936** en **42 ficheros** — reverificada el 2026-08-27 |
| Typecheck **móvil** | **12 errores** — **NO** verde |
| Suite **backend** (`backend/`, 9 ficheros) | **no medida en este corte** — `KNOWN_DEBT.md` registra 4 fallos preexistentes |
| Typecheck **backend** | **no medido en este corte** |
| `git diff --check` | Limpio |

La cifra vigente es la de la tabla: **936 tests móviles en 42 ficheros**,
medidos el 2026-08-27 sobre el mismo objeto `tree` de `mobile/` que publica
`main@63099d8`. La medición anterior, del 2026-08-26 tras `fc9a20e`, dio la
misma cifra. Los **cortes históricos anteriores** fueron 900/900 en 42 ficheros
tras `cb59c7e` y 792/792 en 41 ficheros tras `3c10994`, y ninguno describe ya
la suite actual. El fichero 41 era `startLatencyDecoupling.test.ts`, que aportó
11 tests; el fichero 42 es `localAssembly.test.ts`, que aporta los 108 tests de
D3. **Del resto de incrementos históricos no hay recuento documentado**, y esta
guía no se los atribuye a nada. `compileDebugKotlin` no se ha reejecutado desde
el 20/08.

> Esta línea decía «el salto de 360 a 738 son los ficheros que trajeron los
> findings del bloque de identidad, no una ampliación de cobertura del vídeo».
> Retirada el 2026-08-24: las dos cifras contradecían la tabla inmediatamente
> superior y la atribución no tenía un recuento detrás.

### Findings del 21/08 al 24/08

| Finding | Estado |
|---|---|
| GC-AUTH-MIGRATION-001 | **CLOSED IN HARDWARE** — el único cerrado |
| GC-DEV-RESET-001 | RELEASE BLOCKER · `FIXED IN CODE`, revalidación no requerida |
| GC-DEST-PAUSE-001 | `FIXED IN CODE` / **`HARDWARE REVALIDATED`** — cross-build, 24/08 |
| GC-AUTH-001 | `FIXED IN CODE`; identidad PASS en hardware, flujo completo **no alcanzado** |
| GC-AUTH-SESSION-RECOVERY-001 | **`OPEN`** — prevención (D2-B, D2-C) **validada en banco · evidencia incidental en hardware · validación dirigida PENDIENTE**; supervivencia (D3, salvage local de segmentos) `HARDWARE FUNCTIONAL PASS` el 24/08. **Ninguna cierra el finding** |
| GC-START-LATENCY-001 | `FIXED IN CODE` / **`HARDWARE VALIDATED`** — 24/08; auth dejó de bloquear el arranque, no se volvió rápida |
| GC-DEST-STATUS-001 | **`OPEN`** — backend |
| GC-AUTH-RETRY-CLASSIFICATION-001 | causa **suficiente** demostrada; causalidad con el 22/08 **no** probada |

Detalle y alcance exacto de cada uno en
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#findings-abiertos-de-identidad-destino-y-herramientas)
y en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §1–§6.

### Por qué sigue `NO APTO PARA RELEASE`

Los motivos son ahora otros, y ninguno es la captura de vídeo:

1. **cifrado local no implementado** — sólo existe un `TODO` en el código;
2. **recovery `I5c`** —autónomo tras reiniciar el dispositivo sin abrir la
   app— no implementado;
3. **export final `.mp4`** no implementado ni validado;
4. **un solo dispositivo validado**: sin cobertura multi-dispositivo ni
   Android 13+;
5. **recovery completo de vídeo** no demostrado;
6. sin AAB de producción, Closed Testing ni usuarios externos;
7. **`GC-DEV-RESET-001`** — corregido en código;
8. **`GC-AUTH-SESSION-RECOVERY-001`** — abierto: la sesión de Supabase
   desaparece tras una ventana offline prolongada y la evidencia queda sin
   poder subirse. Desde el 24/08 el vídeo nativo segmentado tiene **salida
   local** por D3 (`HARDWARE FUNCTIONAL PASS`), pero eso es supervivencia, no
   corrección: la identidad no se recupera y la subida no se reanuda;
9. **invariante de migración de identidad** — `RELEASE_CHECKLIST_v0.3.md` §0
   prohíbe publicar `8615ba6` en un build sin `gc.legacy_probe.v1`.

La validación del 20/08 no cubre ninguno de esos nueve puntos y no debe leerse
como si lo hiciera.

> **`GC-DEST-PAUSE-001` salió de esta lista el 2026-08-24**, al completarse su
> revalidación en hardware. Era el punto 7. No estaba etiquetado como release
> blocker, así que su cierre no mueve el veredicto: el sistema **sigue
> `NO APTO PARA RELEASE`** por los nueve motivos de arriba.

### Baseline técnica histórica (2026-07-30)

**Baseline técnica congelada: [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md).**
Es el punto de retorno reproducible del proyecto y lo primero que hay que leer
antes de modificar aquella baseline.

* commit construido `5ac4a03` · build EAS `e98dd3a2-…` · **198/198 tests
  verdes** *(resultado histórico de esa baseline; la condición vigente es que
  toda la suite actual pase, sin cifra fija)*
* **12 errores TypeScript heredados** — el typecheck **no** está verde
* validada en un OnePlus 6 con Android 11; la rama Android 13+ del código nuevo
  **no ha sido probada**
* **no es una release pública**: sin AAB de producción, sin Closed Testing, sin
  usuarios externos

La cifra 198/198 y las limitaciones de vídeo de esa baseline son históricas; no
describen la implementación actual de `feat/native-segmented-recording`.

> **Qué está implementado y qué está validado** se decide en la tabla de tres
> niveles de
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica).
> Es la referencia canónica: cualquier afirmación de este documento que la
> contradiga es incorrecta. La validación del 20/08 cubre la captura nativa, la
> subida durante la captura y el durable cleanup en su ruta normal; **no** se
> puede extender al recovery completo de vídeo, al export `.mp4`, a otros
> dispositivos ni a las rutas artificiales de fallo del scheduler.

Cómo se trabaja a partir de aquí:
[`DEVELOPMENT_WORKFLOW.md`](./DEVELOPMENT_WORKFLOW.md).

Las afirmaciones históricas de más abajo se conservan como contexto de producto
y no sustituyen el estado por capacidad ni los informes de validación vigentes.

## 1. Qué es este proyecto

Guardian Cloud es una aplicación móvil cuyo objetivo es permitir capturar evidencia (audio/vídeo) en situaciones críticas y garantizar que una parte de esa evidencia sobreviva fuera del dispositivo en segundos.

---

## 2. Qué problema resolvemos

En situaciones de riesgo:

- El dispositivo puede ser destruido
- Puede ser confiscado
- Puede perderse
- Puede apagarse

Resultado habitual:
> La evidencia se pierde antes de poder ser guardada

---

## 3. Qué hace Guardian Cloud

- Permite empezar a grabar rápidamente
- Divide la grabación en fragmentos (chunks)
- Sube esos fragmentos en tiempo real
- Envía los datos al almacenamiento elegido por el usuario
- Permite recuperar parte de la evidencia aunque el dispositivo se pierda

---

## 4. Qué NO hace (reglas críticas)

Guardian Cloud NO es:

- ❌ Un servicio de almacenamiento en la nube
- ❌ Un sistema de vigilancia
- ❌ Una solución legal garantizada
- ❌ Una app de grabación tradicional

Regla principal:

> El servidor NO almacena vídeos finales

---

## 5. Arquitectura resumida

### Cliente (App móvil)
- Graba audio/vídeo
- Divide en chunks (2–5s)
- Cifra localmente — **previsto, no implementado en `v0.3.0-rc.1`**
- Sube automáticamente
- Mantiene cola persistente

### Backend (Homelab)
- Autenticación
- Sesiones
- Metadatos
- Estado de subida
- Alertas (modo Kids)

### Base de datos
- Supabase

### Almacenamiento
- Google Drive del usuario
- NAS del usuario
- Otros servicios externos

---

## 6. Promesa real del producto

> Si grabas durante 10 segundos, al menos una parte de esa grabación ya está fuera del dispositivo

NO prometemos:
- protección total
- éxito garantizado
- validez legal automática

---

## 7. Prioridad absoluta

> Subir datos es más importante que grabar perfecto

---

## 8. Filosofía del sistema

- El usuario controla sus datos
- El sistema reduce riesgos, no los elimina
- Simplicidad > complejidad
- Funcionar en condiciones reales > diseño bonito

---

## 9. Modo Guardian Cloud Kids

- Es un modo dentro de la misma app
- NO es una app separada (al inicio)

Funciona así:

- El padre tiene una cuenta
- El hijo está vinculado
- El hijo puede activar grabación
- El contenido se envía al destino del padre
- El padre recibe una notificación

---

## 10. Modelo de negocio

Freemium:

Gratis:
- Funcionalidad básica completa

Premium:
- Funciones avanzadas
- familias
- activistas

---

## 11. Qué construir primero

Orden obligatorio:

1. Backend mínimo (sesiones + chunks)
2. Subida funcional real
3. App móvil básica
4. Cola persistente + reintentos
5. Integración con Drive
6. Pruebas reales de fallo

---

## 12. Qué NO construir todavía

- ❌ UI compleja
- ❌ pagos
- ❌ múltiples apps
- ❌ IA
- ❌ NAS avanzado
- ❌ optimización prematura

---

## 13. Cómo trabajar con este proyecto

Reglas:

- No añadir features sin necesidad
- No desviarse del objetivo principal
- Validar cada fase antes de avanzar
- Probar en condiciones reales

---

## 14. Definición de éxito (MVP)

El proyecto es válido cuando:

- un usuario graba
- pierde el móvil
- y aún así parte del contenido ha sobrevivido

---

## 15. Advertencia importante

Este proyecto puede fallar si:

- la subida no es fiable
- la app no funciona bajo estrés
- la arquitectura se complica demasiado

---

## 16. Regla final

> Si no funciona en una situación real, no funciona

---

## 17. Estado del sistema — HISTÓRICO / SUPERSEDED

> **HISTÓRICO / SUPERSEDED — no describe el estado vigente.**
>
> Este apartado registra lo que se afirmaba en la baseline `v0.2` / v0.3
> temprana, **antes** de la auditoría del 2026-07-28. Aquella auditoría retiró
> la afirmación por no tener registro de prueba detrás. Se conserva en pasado y
> atado a su baseline; **no** debe citarse como estado actual.
>
> Estado vigente: la cabecera de este documento y
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica).

En aquella baseline se declaró validado el core del MVP:

* chunking en tiempo real
* subida resiliente
* recovery tras cierre de app
* subida en background
* export de evidencia funcional

Y se concluyó que el sistema **había dejado** de ser un prototipo.

Ninguna de esas dos afirmaciones se sostiene hoy en esos términos. Lo que sí
está implementado y con qué evidencia se decide capacidad por capacidad en la
tabla de tres niveles, no aquí.

---

## 18. Fase actual

El proyecto está en fase de:

* consolidación del MVP
* mejora de UX (botón pánico, estados)
* validación con usuarios reales

---

## 19. Prioridad actual

1. facilitar activación rápida (botón pánico)
2. garantizar export usable
3. validar uso real

---

## 20. Regla de evolución

> No añadir nuevas funcionalidades sin validar el uso real del sistema actual

## Jerarquía de documentación

En caso de conflicto:

1. PRODUCT_PRINCIPLES.md
2. MVP_SCOPE.md
3. ARCHITECTURE.md / API_SPEC.md
4. UI / UX docs
5. resto

La validación final siempre se basa en:
TEST_SCENARIOS.md
