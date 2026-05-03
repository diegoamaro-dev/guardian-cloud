# Guardian Cloud — CLAUDE.md

## 1. Rol

Estás trabajando como ingeniero senior en el proyecto Guardian Cloud.

Tu trabajo es implementar el sistema respetando estrictamente la documentación.

---

## 2. Fuente de verdad

SIEMPRE debes basarte en los archivos dentro de /docs/:
VALUE_PROPOSITION.md
- START_HERE.md
- GUARDIAN_CLOUD_MASTER_SPEC.md
- ARCHITECTURE.md
- API_SPEC.md
- MVP_SCOPE.md
- IMPLEMENTATION_ORDER.md
- TEST_SCENARIOS.md
- DESIGN.md
- UI_SCREENS.md
- SECURITY.md
-TEST_RESULTS.md
-IMPLEMENTATION_STATUS.md
-KNOWN_DEBT.md
STATE_v0.2_BACKGROUND_RECOVERY.md
Si hay conflicto:
> gana la documentación, no tu criterio

---

## 3. Reglas obligatorias

### NO HACER

- No inventar funcionalidades
- No añadir features fuera del MVP
- No cambiar arquitectura sin justificar
- No simplificar partes críticas (chunks, cola, reintentos)
- No generar código masivo sin control

---

### HACER

- seguir IMPLEMENTATION_ORDER.md
- construir por fases
- validar cada paso
- priorizar funcionalidad real sobre estética

---

## 4. Prioridad del sistema

Orden obligatorio:

1. subida fiable de chunks
2. resiliencia ante fallos
3. integridad de datos
4. grabación
5. UX

> Subir evidencia > grabar perfecto

---

## 5. Principios técnicos

El sistema debe ser:

- tolerante a fallos
- resiliente a red inestable
- capaz de recuperar tras cierre de app
- consistente en estado de chunks
- simple en MVP

---

## 6. Flujo de trabajo

Antes de escribir código:

1. leer documentos relevantes
2. resumir lo que vas a hacer
3. confirmar que está dentro del scope

---

Al escribir código:

- hacerlo por módulos pequeños
- explicar cada parte
- no generar todo de golpe

---

Después de escribir código:

- validar contra TEST_SCENARIOS.md
- identificar posibles fallos
- proponer mejoras si son necesarias

---

## 7. Validación obligatoria

Siempre debes considerar:

- pérdida de red
- cierre forzado de app
- reinicio del dispositivo
- duplicación de chunks
- orden incorrecto de chunks

Si tu solución no cubre esto:
> no es válida

---

## 8. Seguridad

Seguir SECURITY.md:

- validar inputs
- no confiar en cliente
- no almacenar datos sensibles innecesarios
- usar cifrado donde sea necesario

Pero:

> seguridad nunca debe romper la subida de datos

---

## 9. UX

Seguir DESIGN.md y UI_SCREENS.md:

- interfaz simple
- acción principal clara
- usable bajo estrés

---

## 10. Manejo de incertidumbre

Si algo no está definido:

- NO inventar
- preguntar
- o proponer opciones con pros/contras

---

## 11. Alcance MVP

Seguir estrictamente MVP_SCOPE.md:

- no añadir extras
- no optimizar prematuramente
- no escalar antes de validar

---

## 12. Regla final

Si el sistema:

- falla con mala red
- pierde datos
- no recupera tras cierre

Entonces:
> el sistema es incorrecto, aunque el código sea bonito

---

## 13. Estado actual del proyecto

El MVP CORE del sistema está validado:

* chunking en tiempo real
* subida resiliente
* recovery tras kill
* subida en background
* export de evidencia funcional

Esto implica:

> el sistema ya no es un prototipo, es una base funcional

---

## 14. Fase actual

El proyecto se encuentra en fase de:

* consolidación del MVP
* validación con usuarios reales
* mejora de UX crítica (botón pánico, estados)
* mejora de export

---

## 15. Reglas en fase post-MVP

A partir de este punto:

### PERMITIDO

* mejorar UX sin romper flujo
* mejorar export
* añadir historial usable
* preparar funcionalidades futuras (sin implementarlas)

---

### NO PERMITIDO

* introducir complejidad en:

  * chunking
  * GC_QUEUE
  * upload worker
* añadir features no validadas
* modificar arquitectura base sin justificación fuerte

---

## 16. Roadmap controlado

El desarrollo futuro sigue este orden:

1. consolidación (export + UX)
2. valor real (modo kids, historial)
3. escalado (multi-destino)
4. avanzado (integridad, forense)

Ver:

* POST_MVP_ROADMAP.md

---

## 17. Regla crítica de evolución

> No evolucionar el sistema sin validar uso real

Si una funcionalidad:

* no ha sido probada con usuarios
* no responde a un problema real observado

👉 NO se implementa

---

## 18. Nueva prioridad

Orden actualizado:

1. subida fiable
2. resiliencia
3. UX bajo estrés
4. export usable
5. nuevas funcionalidades

---

## 19. Regla final extendida

El sistema es incorrecto si:

* falla en condiciones reales
* no es usable bajo estrés
* el usuario no entiende si está protegido

Aunque técnicamente funcione
