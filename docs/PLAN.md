# Guardian Cloud — PLAN.md

## PROPÓSITO

Guardian Cloud existe para garantizar que la evidencia sobreviva aunque el dispositivo falle.

La prioridad del sistema es:

> supervivencia de evidencia > grabación perfecta

Si la evidencia no se sube DURANTE o inmediatamente después de la grabación,
el producto falla en su objetivo principal.

---

# FILOSOFÍA DEL PRODUCTO

Guardian Cloud NO es:

- una app social
- una red social
- una plataforma de vigilancia
- una nube tradicional
- un editor multimedia
- una app “bonita”

Guardian Cloud ES:

- una herramienta de supervivencia de evidencia
- un sistema resiliente
- un sistema recovery-first
- una herramienta simple y rápida
- una app orientada a confianza

---

# INVARIANTES (NO ROMPER)

Estas reglas tienen prioridad sobre cualquier feature futura.

## CRÍTICOS

- subida durante grabación o inmediatamente tras finalizar
- cola persistente local
- recovery automático tras cierre/crash/reinicio
- evidencia fuera del dispositivo ASAP
- export usable y verificable
- worker independiente de la UI
- UI observadora, NO controladora

## PROHIBIDO

- lógica compleja en UI
- dependencias entre pantallas y upload
- bloquear subida por UX
- rehacer arquitectura sin necesidad real
- optimizaciones prematuras
- refactors masivos sin tests destructivos

---

# ESTADO ACTUAL REAL

## VALIDADO

- grabación audio
- grabación vídeo
- chunking incremental
- cola persistente AsyncStorage
- upload worker single-flight
- subida Google Drive
- recovery tras kill app
- recovery tras reinicio backend
- background Android
- completion gate
- export funcional
- deduplicación básica
- limpieza segura local
- standalone APK

## TESTS PASADOS

- modo avión
- backend caído
- cierre forzado
- reopen recovery
- subida en background
- reinicio upload
- export post-recovery

---

# PRIORIDAD ACTUAL

## OBJETIVO ÚNICO

Blindar estabilidad y preparar beta cerrada.

Todo lo demás es secundario.

---

# ROADMAP

## v0.3 — Sistema superviviente

Objetivo:
demostrar supervivencia real.

Incluye:
- audio
- vídeo post-stop
- recovery
- export
- background
- standalone
- Drive

NO incluye:
- Kids
- live video upload
- panel web complejo
- IA
- NAS avanzada

---

## v0.4 — Blindaje

Objetivo:
hacer recovery extremadamente robusto.

Incluye:
- watchdogs
- retries avanzados
- integrity checks
- mejor dedup
- cleanup seguro
- métricas internas
- export reforzado

Investigación:
- vídeo live experimental aislado

---

## v0.5 — Beta cerrada

Objetivo:
usuarios reales.

Incluye:
- UX mínima final
- onboarding simple
- mensajes humanos
- branding básico
- flujo entendible en <2s

Mensaje principal:

> “Aunque pierdas el móvil, la evidencia sigue protegida.”

---

## v1.0 — Lanzamiento

Objetivo:
producto público estable.

Debe tener:
- recovery sólido
- export fiable
- Drive estable
- background robusto
- standalone
- UX clara
- onboarding simple
- estabilidad real

---

# ROADMAP POST-LANZAMIENTO

## v1.1 — Vídeo live

Subida DURANTE grabación vídeo.

Solo entra si:
- NO rompe recovery
- NO rompe estabilidad
- mejora supervivencia real

---

## v1.2 — NAS & soberanía

- WebDAV
- Synology
- TrueNAS
- Nextcloud
- multi-destino

---

## v1.3 — Guardian Cloud Kids

Sistema familiar separado.

Incluye:
- cuentas guardianes
- menores
- permisos familiares
- políticas específicas

NO convertir en sistema de vigilancia invasiva.

---

## v1.4 — Emergencia avanzada

- panic mode
- widget Android
- grabación rápida
- triggers emergencia
- subida agresiva

---

## v1.5 — Cadena de custodia

- manifests firmados
- hashes completos
- integridad verificable
- export forense

---

# PRINCIPIOS TÉCNICOS

## ARQUITECTURA

- GC_QUEUE es fuente de verdad
- upload worker independiente
- single-flight uploads
- recovery-first
- offline-first
- background-safe
- failure-tolerant

## PRIORIDADES

1. supervivencia
2. recovery
3. simplicidad
4. confianza
5. UX

---

# UX PRINCIPLES

El usuario debe entender la app en menos de 2 segundos.

La UX debe transmitir:
- rapidez
- seguridad
- claridad
- tranquilidad

## REGLAS

- mínimo texto posible
- mínimo número de pantallas
- mínimo número de decisiones
- grabar debe ser inmediato
- estados claros
- lenguaje humano

## EVITAR

- términos técnicos
- dashboards complejos
- configuraciones avanzadas visibles
- pasos innecesarios
- sobreexplicación

---

# QUÉ NO HACER AHORA

NO HACER:
- IA
- refactors grandes
- rediseño completo
- microservicios
- Kubernetes
- multi-cloud compleja
- panel web avanzado
- analytics complejos
- features sociales
- chat
- vigilancia familiar
- live video prematuro

---

# REGLA FINAL

Cada nueva feature debe responder:

> “¿Esto mejora supervivencia, claridad o confianza?”

Si la respuesta es NO:
NO entra.

---

# MÉTRICAS REALES DE ÉXITO

NO:
- likes
- dashboards
- features
- complejidad

SÍ:
- recovery exitoso
- chunks supervivientes
- export usable
- estabilidad Android
- tiempo hasta grabar
- comprensión instantánea
- confianza del usuario

---

# MENSAJE CENTRAL DEL PRODUCTO

NO decir:

- chunking
- sync distribuido
- pipelines
- uploads incrementales

SÍ decir:

> “Aunque pierdas el móvil, la evidencia sigue existiendo.”
