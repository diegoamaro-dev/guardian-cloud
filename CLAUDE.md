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