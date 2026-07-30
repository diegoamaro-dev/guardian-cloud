# Guardian Cloud

Aplicación móvil de evidencia centrada en la supervivencia temprana de grabaciones: fragmenta la captura, mantiene una cola persistente y sube los fragmentos al almacenamiento del propio usuario.

> **El cifrado local no está implementado.** Figura en `MVP_SCOPE.md` y
> `SECURITY.md` como objetivo del producto, no como capacidad actual.

---

## 🧠 Qué hace realmente

Guardian Cloud permite:

* grabar audio/vídeo
* dividir en chunks
* **subir en tiempo real durante la grabación — sólo en modo audio.** El vídeo
  se fragmenta y encola **después** de detener la captura (`GC-AUD-001`)
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

**Cumplido hoy sólo en audio.** En vídeo, este objetivo todavía no se satisface
(`GC-AUD-001`): resolverlo es la fase D y la siguiente prioridad funcional.

---

## ⚙️ Estado actual

⛔ **Veredicto vigente: `NO APTO`** — auditoría 2026-07-28. Empezar por
[`START_HERE.md`](./START_HERE.md).

**Baseline técnica congelada:** [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md)
(2026-07-30) — punto de retorno reproducible, **no** una release pública.

El sistema actualmente:

* ✔ grabación funcional
* ✔ chunking en tiempo real **sólo en audio**
* ✔ subida a Google Drive
* ✔ cola persistente (AsyncStorage)
* ✔ recovery tras kill / arranque de la app
* ✔ subida en background
* ✔ export de evidencia (`.m4a`)
* ❌ **el vídeo NO saca evidencia del dispositivo durante la grabación**
  (GC-AUD-001) — encola después de parar
* ❌ sin `capture_end_reason`: no se puede probar finalización limpia
* ❌ recovery automático tras reinicio del dispositivo (I5c) no implementado
* ❌ cifrado local no implementado

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

* archivo `.m4a` / `.mp4`
* usable fuera de la app

---

## 📄 Documentación principal

Leer en este orden:

1. docs/START_HERE.md
2. **docs/releases/v0.3.0-rc.1.md** — baseline técnica vigente
3. **docs/DEVELOPMENT_WORKFLOW.md** — cómo se avanza sobre la baseline
4. docs/MVP_SCOPE.md
5. docs/ARCHITECTURE.md
6. docs/API_SPEC.md
7. docs/DESIGN.md
8. docs/UI_SCREENS.md
9. docs/SECURITY.md

Auditoría y estado real:

* docs/audits/ — los tres informes ratificados
* docs/IMPLEMENTATION_STATUS.md
* docs/KNOWN_DEBT.md
* docs/RELEASE_CHECKLIST_v0.3.md
* docs/PLAYSTORE_RELEASE_PLAN.md

---

## 🧪 Validación

**198/198 tests automáticos verdes** · **12 errores TypeScript heredados**
(typecheck NO verde) · sin CI.

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
