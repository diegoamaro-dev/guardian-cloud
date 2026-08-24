# Guardian Cloud

Aplicación móvil de evidencia centrada en la supervivencia temprana de grabaciones: fragmenta la captura, mantiene una cola persistente y sube los fragmentos al almacenamiento del propio usuario.

> **El cifrado local no está implementado.** Figura en `MVP_SCOPE.md` y
> `SECURITY.md` como objetivo del producto, no como capacidad actual.

---

## 🧠 Qué hace realmente

Guardian Cloud permite:

* grabar audio/vídeo
* dividir en chunks
* **subir en tiempo real durante la grabación, en audio y en vídeo.** La ruta
  nativa segmentada cierra, adopta y sube segmentos MP4 mientras la captura
  sigue en curso; demostrado en hardware el 20/08
* sobrevivir a:

  * pérdida de conexión
  * cierre forzado
  * **reinicio del dispositivo, con matiz:** la cola persistida sobrevive al
    reinicio y **continúa drenándose cuando el usuario vuelve a abrir la
    aplicación**. El arranque automático o recovery autónomo tras reiniciar
    —sin abrir la app— **sigue sin implementarse** (`I5c`): no hay receptor de
    `BOOT_COMPLETED` ni planificador de trabajo diferido

---

## 🎯 Objetivo

> Si grabas durante unos segundos, al menos una parte de esa evidencia ya está fuera del dispositivo.

**Cumplido en audio y en vídeo.** En vídeo quedó demostrado físicamente el
20/08: primera subida confirmada a `+14,619 s` frente a un PARAR en `+75,514 s`,
con 11 de 12 fragmentos confirmados fuera del dispositivo antes de detener la
captura. `GC-AUD-001` deja de ser un defecto vigente.

---

## ⚙️ Estado actual

⛔ **Veredicto vigente: `NO APTO PARA RELEASE`** — por cifrado local, recovery
`I5c`, export `.mp4`, cobertura de dispositivos **y findings de
identidad/destino todavía no cerrados**. **Ya no por `GC-AUD-001`.**
Empezar por [`START_HERE.md`](./START_HERE.md).

> **Bloque de identidad (21/08 – 24/08).** Ocho findings registrados; **uno
> cerrado en hardware** (`GC-AUTH-MIGRATION-001`) y **otro revalidado en
> hardware** el 24/08 (`GC-DEST-PAUSE-001`, `FIXED IN CODE` /
> `HARDWARE REVALIDATED`). Un release blocker corregido en código
> (`GC-DEV-RESET-001`). Los demás permanecen corregidos o abiertos con
> distintos niveles de validación; el más grave de los que siguen `OPEN` es
> `GC-AUTH-SESSION-RECOVERY-001`. Tabla completa en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#findings-abiertos-de-identidad-destino-y-herramientas)
> y detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md).

> **Qué está implementado y qué está validado:** la referencia canónica es la
> tabla de tres niveles en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica).
> Resumen: **nivel 1** audio completo de extremo a extremo, más vídeo nativo
> segmentado con subida durante la captura y durable cleanup en su ruta normal,
> `HARDWARE_VALIDATED` en un OnePlus A6000 con Android 11; **nivel 2**
> Reliability Card, Android 13+, matriz de resiliencia y las rutas artificiales
> de fallo del scheduler, implementados pero sin validar en dispositivo;
> **nivel 3** recuperación completa del vídeo y export `.mp4`, no implementados.

**Baseline técnica congelada:** [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md)
(2026-07-30) — punto de retorno reproducible, **no** una release pública.

El sistema actualmente:

* ✔ grabación funcional
* ✔ chunking en tiempo real en audio **y en vídeo** (ruta nativa segmentada)
* ✔ **el vídeo saca evidencia del dispositivo durante la grabación** —
  `HARDWARE_VALIDATED` 20/08
* ✔ subida a Google Drive
* ✔ cola persistente (AsyncStorage)
* ✔ recovery tras kill / arranque de la app
* ✔ recovery de una sesión pendiente tras restaurar la autorización de Drive
* ✔ subida en background
* ✔ durable cleanup del almacenamiento local en la ruta normal
* ✔ export de evidencia (`.m4a`)
* ✔ captura local-first: la grabación no depende de tener identidad remota
* ✔ frontera de migración de identidad sellada durablemente (`gc.legacy_probe.v1`)
* ❌ sin `capture_end_reason`: no se puede probar finalización limpia
* ❌ recovery automático tras reinicio del dispositivo (I5c) no implementado
* ❌ cifrado local no implementado
* ❌ export final `.mp4` no implementado
* ❌ un solo dispositivo validado: sin cobertura multi-dispositivo ni Android 13+
* ❌ **la sesión de Supabase puede desaparecer tras una ventana offline
  prolongada y dejar la evidencia sin poder subirse** (`GC-AUTH-SESSION-RECOVERY-001`, abierto)
* ✅ `GC-START-LATENCY-001` = **`FIXED IN CODE` / `HARDWARE VALIDATED`** (24/08).
  Aquí decía que «el inicio de captura se bloquea ~4½ min con la red remota
  muerta». Ya no: **auth puede seguir tardando, pero ya no bloquea START**.
  Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §6
* ❌ **un destino Drive revocado sigue reportándose `connected`**
  (`GC-DEST-STATUS-001`, abierto, backend)

Las afirmaciones históricas de validación de este repositorio quedaron retiradas
por la auditoría. Ver [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md).

---

## 🧱 Arquitectura (resumen)

* App móvil → captura + chunking + subida
* Backend → sesiones + metadatos
* Supabase → auth + estado
* Destino → Google Drive del usuario

---

## 📦 Evidencia

* los datos se fragmentan en chunks
* se suben de forma incremental
* la evidencia final se reconstruye en cliente

Export:

* **`.m4a` (audio) — implementado y validado**, usable fuera de la app
* **`.mp4` (vídeo) — planificado, no implementado ni validado**

---

## 📄 Documentación principal

Leer en este orden:

1. docs/START_HERE.md
2. **docs/IMPLEMENTATION_STATUS.md** — referencia canónica de qué está implementado y qué validado
3. **docs/KNOWN_LIMITS.md** — límites vigentes y findings §1–§6
4. **docs/RELEASE_CHECKLIST_v0.3.md** — §0 es un invariante **bloqueante** de release
5. **docs/releases/v0.3.0-rc.1.md** — baseline técnica vigente
6. **docs/DEVELOPMENT_WORKFLOW.md** — cómo se avanza sobre la baseline
7. docs/MVP_SCOPE.md
8. docs/ARCHITECTURE.md
9. docs/API_SPEC.md
10. docs/DESIGN.md
11. docs/UI_SCREENS.md
12. docs/SECURITY.md

Auditoría y estado real:

* docs/audits/ — los tres informes ratificados
* docs/IMPLEMENTATION_STATUS.md
* docs/KNOWN_DEBT.md
* docs/RELEASE_CHECKLIST_v0.3.md
* docs/PLAYSTORE_RELEASE_PLAN.md

---

## 🧪 Validación

**Condición vigente: toda la suite actual debe pasar, sin tests saltados.** No
se fija aquí ninguna cifra como objetivo: quedaría obsoleta al añadir pruebas y
empujaría a «arreglar» el documento en vez del código. Registrar el total
observado al ejecutarla.

Última ejecución registrada: **792/792 en 41 ficheros**, el 2026-08-24, tras
`3c10994`.

**12 errores TypeScript heredados** (typecheck **NO** verde) · sin CI.

Resultados históricos, por baseline: **198/198** en `v0.3.0-rc.1`, **263/263** en
`baseline-fea160c-android11-20260730`, **360/360** en el corte del 2026-08-20.

La baseline `v0.3.0-rc.1` distingue tres niveles de evidencia —verificado por
instrumentación, atestiguado manualmente, y no ejecutado— y **no marca como
superado nada sin evidencia de su nivel**. Ver su matriz de pruebas.

Sin cobertura: rama Android 13+, Closed Testing, usuarios externos.

Ver:

* `releases/v0.3.0-rc.1.md` — matriz de pruebas vigente
* `TEST_SCENARIOS.md`
* `TEST_RESULTS.md`

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

Ver:

* `POST_MVP_ROADMAP.md`

---

## ⚠️ Regla del proyecto

> No añadir complejidad antes de validar el flujo crítico

---

## 🧨 Regla final

> Si no funciona en condiciones reales, no funciona
