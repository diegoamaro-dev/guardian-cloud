# Guardian Cloud — START HERE

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
- Cifra localmente
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
