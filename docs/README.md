# Guardian Cloud

Aplicación móvil de evidencia segura centrada en supervivencia temprana de grabaciones mediante chunking, cifrado local y subida al almacenamiento del usuario.

---

## 🧠 Qué hace realmente

Guardian Cloud permite:

* grabar audio/vídeo
* dividir en chunks
* subir en tiempo real
* sobrevivir a:

  * pérdida de conexión
  * cierre forzado
  * reinicio del dispositivo

---

## 🎯 Objetivo

> Si grabas durante unos segundos, al menos una parte de esa evidencia ya está fuera del dispositivo.

---

## ⚙️ Estado actual

El sistema actualmente:

* ✔ grabación funcional
* ✔ chunking en tiempo real
* ✔ subida a Google Drive
* ✔ cola persistente (AsyncStorage)
* ✔ recovery tras kill/reinicio
* ✔ subida en background
* ✔ export de evidencia (`.m4a`)

👉 MVP CORE: VALIDADO

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
2. docs/MVP_SCOPE.md
3. docs/ARCHITECTURE.md
4. docs/API_SPEC.md
5. docs/DESIGN.md
6. docs/UI_SCREENS.md
7. docs/SECURITY.md

---

## 🧪 Validación

El sistema ha sido probado en:

* cierre forzado
* pérdida de red
* background
* recovery tras reinicio

Ver:

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
