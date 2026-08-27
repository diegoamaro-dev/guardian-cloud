# Guardian Cloud

Aplicación móvil de evidencia centrada en la supervivencia temprana de grabaciones: fragmenta la captura, mantiene una cola persistente y sube los fragmentos al almacenamiento del propio usuario.

> **El cifrado local no está implementado.** Figura en `MVP_SCOPE.md` y
> `SECURITY.md` como objetivo del producto, no como capacidad actual.

> **Qué es este documento.** Una puerta de entrada al proyecto: qué es Guardian
> Cloud, qué garantiza y cómo razonar sobre él. **No es el registro del estado
> técnico.** Ese estado cambia con cada gate y su referencia canónica es
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica);
> si algo de aquí la contradice, **gana ella**.

---

## 🧠 Qué hace realmente

Guardian Cloud permite:

* grabar audio/vídeo
* dividir en chunks
* **subir en tiempo real durante la grabación, en audio y en vídeo.** La ruta
  nativa segmentada cierra, adopta y sube segmentos MP4 mientras la captura
  sigue en curso. Demostrado en hardware **en un solo dispositivo**; el alcance
  exacto de esa validación está en
  [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica)
* sobrevivir a:

  * pérdida de conexión
  * cierre forzado
  * **reinicio del dispositivo, con matiz** — ver «Recovery, y qué NO es»

---

## 🎯 Objetivo y principio

> Si grabas durante unos segundos, al menos una parte de esa evidencia ya está fuera del dispositivo.

Y la regla de decisión que se deriva de él:

> **Subir evidencia > grabación perfecta**

Ante cualquier disyuntiva, el sistema prefiere que la evidencia salga del
dispositivo antes que producir una grabación impecable. Fuente:
[`PRODUCT_PRINCIPLES.md`](./PRODUCT_PRINCIPLES.md).

El objetivo está **cumplido en audio y en vídeo dentro del alcance validado**:
la evidencia sale del dispositivo **durante** la captura, no después de parar.
`GC-AUD-001` —el defecto por el que el vídeo sólo se encolaba tras parar— **deja
de ser un defecto vigente**.

---

## 🧱 Arquitectura conceptual

* **App móvil** → captura, fragmentación, cola y subida
* **Backend** → sesiones y metadatos
* **Supabase** → identidad y estado
* **Destino** → almacenamiento del propio usuario (Google Drive; NAS previsto)

> **El servidor NO almacena la evidencia final.** Los chunks van al destino del
> usuario; el backend describe la sesión, no la custodia.

### La cola es la fuente de verdad

* **`GC_QUEUE` es la fuente de verdad** del trabajo pendiente — no la UI, no el
  estado en memoria, no el backend
* cola **persistente** (AsyncStorage): sobrevive al cierre forzado y al reinicio
* **worker single-flight con reintentos**: una sola subida en vuelo, con
  reintento de los fallos transitorios
* **la subida puede continuar en background** — la evidencia sale del dispositivo
  ASAP sin depender del primer plano. **Es transporte, no captura:** no implica
  cámara en background (**NO autorizada**) ni `VIDEO_AUDIO → AUDIO_ONLY` implementado

### Recovery, y qué NO es

* **recovery automático tras kill y al abrir la app** — implementado
* **`I5c` — recovery autónomo tras reiniciar el dispositivo, sin abrir la app —
  NO implementado.** No hay receptor de `BOOT_COMPLETED` ni planificador de
  trabajo diferido

La distinción importa: tras un reinicio la cola persistida **sigue ahí y se
drena**, pero **sólo cuando el usuario vuelve a abrir la aplicación**.

---

## 📦 Evidencia y export

* los datos se fragmentan en chunks
* se suben de forma incremental
* la evidencia final se reconstruye en cliente

Export:

* **`.m4a` (audio) — implementado y validado**, usable fuera de la app
* **`.mp4` (vídeo) — planificado, NO implementado ni validado**

### D3 `LOCAL SEGMENT SALVAGE` no es el export final

Cuando una captura de vídeo nativo segmentado se queda sin salida cloud, D3
permite copiar del sandbox los **segmentos MP4 originales** —ordenados y
verificados por `sha256` en destino— a una carpeta que elige el usuario.

**No es el export final `.mp4`.** Los segmentos son contenedores MP4
**independientes** y no se concatenan: unirlos byte a byte no produce un MP4
válido. D3 **no produce** vídeo reconstruido ni grabación completa, y **no
corrige** la causa por la que la sesión se quedó sin salida —la identidad no se
recupera y la subida no se reanuda—. Es supervivencia, no corrección.

Alcance y evidencia en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md).

---

## 🛡️ Continuous Protection — contrato aceptado, NO implementado

`VIDEO_AUDIO → AUDIO_ONLY` —que la protección continúe en audio cuando la
captura de vídeo pierde el primer plano— tiene **contrato aceptado** y decisión
registrada, pero **la capacidad NO está implementada ni validada**. Hoy,
minimizar durante vídeo cierra la sesión igual que antes.

```
Contrato aceptado                        sí
VIDEO_AUDIO → AUDIO_ONLY implementado    NO
Cámara en background                     NO AUTORIZADA
G4                                       BLOQUEADO
```

* **La cámara en background NO está autorizada.** Es una prohibición explícita
  del ADR, no una limitación pendiente de resolver.
* **`G3''` desplegado NO significa Continuous Protection funcionando.** `G3''`
  —la descripción del medio de la evidencia por chunk, en backend y manifiesto—
  está implementado, publicado y desplegado, y su **validación funcional cubre
  exclusivamente `media='audio'`**. Es una precondición de integridad: no
  habilita evidencia mixta, no implementa la transición y no cambia el veredicto
  de release.
* **`G4` sigue BLOQUEADO**, por la causa que `G3''` nunca abordó: la transición
  no está implementada y ningún productor puede crear evidencia mixta.

Decisión, alcance y prohibiciones:
[`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md).
Estado por capacidad: nivel 3 de
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica).

---

## ⚙️ Estado actual

⛔ **Veredicto vigente: `NO APTO PARA RELEASE`.**

Entre los motivos —**la lista completa y vigente está en
[`START_HERE.md`](./START_HERE.md)**— hay al menos:

* **cifrado local** no implementado
* **recovery `I5c`** no implementado
* **export final `.mp4`** no implementado
* **un solo dispositivo validado**: sin cobertura multi-dispositivo ni Android 13+
* **findings de identidad y destino** todavía no cerrados
* el **§0 de [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md)** —
  invariante de migración de identidad, **bloqueante**

**`GC-AUD-001` ya no es uno de esos motivos.**

> **Findings abiertos.** Hay findings vigentes de identidad, destino, evidencia
> y OAuth, con niveles de validación distintos entre sí. **Este documento no los
> enumera a propósito**: el inventario cambia, y mantenerlo por duplicado
> garantiza que una de las dos copias esté mal. Estado por finding en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#findings-abiertos-de-identidad-destino-y-herramientas),
> detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) y deuda en
> [`KNOWN_DEBT.md`](./KNOWN_DEBT.md).

**Baseline técnica congelada:** [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md)
(2026-07-30) — punto de retorno reproducible, **no** una release pública.

---

## 📄 Documentación

Leer en este orden:

1. [`START_HERE.md`](./START_HERE.md)
2. **[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)** — referencia canónica de qué está implementado y qué validado
3. **[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md)** — límites vigentes y findings abiertos
4. **[`KNOWN_DEBT.md`](./KNOWN_DEBT.md)** — deuda técnica conocida
5. **[`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md)** — §0 es un invariante **bloqueante** de release
6. **[`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md)** — baseline técnica congelada
7. **[`DEVELOPMENT_WORKFLOW.md`](./DEVELOPMENT_WORKFLOW.md)** — cómo se avanza sobre la baseline
8. [`MVP_SCOPE.md`](./MVP_SCOPE.md)
9. [`ARCHITECTURE.md`](./ARCHITECTURE.md)
10. [`API_SPEC.md`](./API_SPEC.md)
11. [`DESIGN.md`](./DESIGN.md)
12. [`UI_SCREENS.md`](./UI_SCREENS.md)
13. [`SECURITY.md`](./SECURITY.md)

Decisiones de arquitectura: [`decisions/`](./decisions/) — en particular
[`ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md).

Validación física del estado actual — las dos que
[`START_HERE.md`](./START_HERE.md) cita como evidencia vigente:

* [validación del vídeo nativo con durable cleanup, 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md)
* [validación de la integración nativa segmentada, 13/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md)

El resto de [`audits/`](./audits/) y de [`VALIDATIONS/`](./VALIDATIONS/) es
**registro histórico fechado**: describe el estado en su fecha, no el actual.

---

## 🧪 Validación

**Condición vigente: toda la suite actual debe pasar, sin tests saltados.** No
se fija aquí ninguna cifra como objetivo: quedaría obsoleta al añadir pruebas y
empujaría a «arreglar» el documento en vez del código. Registrar el total
observado al ejecutarla.

El **typecheck NO está verde** —hay errores heredados— y **no hay CI**.

La última ejecución registrada, con su cifra y el commit sobre el que se midió,
está en [`START_HERE.md`](./START_HERE.md).

La baseline `v0.3.0-rc.1` distingue tres niveles de evidencia —verificado por
instrumentación, atestiguado manualmente, y no ejecutado— y **no marca como
superado nada sin evidencia de su nivel**. Ver su matriz de pruebas.

Sin cobertura: rama Android 13+, Closed Testing, usuarios externos.

Ver:

* [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) — matriz de pruebas de la baseline
* [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md)
* [`TEST_RESULTS.md`](./TEST_RESULTS.md) — registro histórico

---

## 🚀 Roadmap

Fase actual:

* consolidación del MVP
* export robusto
* botón de pánico

Siguientes fases:

* modo kids (alertas)
* historial usable
* múltiples destinos (Drive / NAS)
* integridad avanzada (no MVP)

Ver [`strategy/POST_MVP_ROADMAP.md`](../strategy/POST_MVP_ROADMAP.md) —
contexto, no vinculante para el sistema actual.

---

## ⚠️ Regla del proyecto

> No añadir complejidad antes de validar el flujo crítico

---

## 🧨 Regla final

> Si no funciona en condiciones reales, no funciona
