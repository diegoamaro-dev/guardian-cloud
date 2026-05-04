# Guardian Cloud — Development Workflow

## 🎯 Objetivo

Definir el flujo completo de trabajo para:

- evitar errores
- mantener estabilidad
- asegurar validación real

---

# 🧨 REGLA BASE

> No escribir código sin pensar antes  
> No hacer commit sin validar después

---

# 🧱 1. INICIO DE TAREA

Antes de tocar código:

## Paso obligatorio

Completar:

CLAUDE_PRETASK_CHECK.md

---

## Debes tener claro:

- qué vas a hacer
- qué archivos tocarás
- qué invariantes pueden verse afectados
- cómo vas a validar

---

# 🧠 2. IMPLEMENTACIÓN

Reglas:

- cambios pequeños
- NO refactors grandes
- NO tocar partes críticas sin motivo
- NO añadir complejidad

---

## Prohibido:

- cambiar GC_QUEUE sin necesidad
- tocar upload worker sin entender impacto
- mover lógica a UI

---

# 🧪 3. VALIDACIÓN

Antes de commit:

## Tests mínimos:

- grabar
- cortar red
- cerrar app
- abrir app
- verificar recovery
- completar sesión
- exportar

---

## Debe cumplir:

- no pérdida de chunks
- subida consistente
- recovery automático
- export usable

---

# 🧨 4. PRE-COMMIT CHECK

Ejecutar:

```bash
git diff