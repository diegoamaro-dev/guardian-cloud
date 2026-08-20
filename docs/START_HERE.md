# Guardian Cloud — START HERE

⛔ NO APTO PARA RELEASE — por cifrado local, recovery `I5c`, export `.mp4` y cobertura de dispositivos. **Ya no por `GC-AUD-001`.**

Este documento contiene referencias históricas que deben leerse con la fecha y
el alcance de su evidencia. El estado vigente se reconstruye desde:

* [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica),
  referencia canónica del estado por capacidad;
* [validación física del vídeo nativo con durable cleanup del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md);
* [validación física de la integración nativa segmentada del 13/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md).

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
* **Validación automática actual:** 360/360 tests; typecheck con los mismos 12
  errores TypeScript históricos y cero nuevos; Kotlin
  `:gc-segmented-recorder:compileDebugKotlin` con `BUILD SUCCESSFUL`;
  `git diff --check` limpio.

### Por qué sigue `NO APTO PARA RELEASE`

Los motivos son ahora otros, y ninguno es la captura de vídeo:

1. **cifrado local no implementado** — sólo existe un `TODO` en el código;
2. **recovery `I5c`** —autónomo tras reiniciar el dispositivo sin abrir la
   app— no implementado;
3. **export final `.mp4`** no implementado ni validado;
4. **un solo dispositivo validado**: sin cobertura multi-dispositivo ni
   Android 13+;
5. **recovery completo de vídeo** no demostrado;
6. sin AAB de producción, Closed Testing ni usuarios externos.

La validación del 20/08 no cubre ninguno de esos seis puntos y no debe leerse
como si lo hiciera.

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

## 17. Estado actual del sistema

El MVP core del sistema está validado:

* chunking en tiempo real
* subida resiliente
* recovery tras cierre de app
* subida en background
* export de evidencia funcional

El sistema ya no es un prototipo.

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
