Crea docs/BETA_TEST_MATRIX.md para Guardian Cloud.

Objetivo:
preparar beta cerrada con pruebas reales, no técnicas de laboratorio.

NO tocar código.
NO modificar arquitectura.
NO añadir features.

El documento debe incluir:

1. Objetivo de la beta
2. Reglas de prueba
3. Perfil de testers
4. Matriz de pruebas por categoría:
   - grabación normal
   - modo avión
   - backend caído
   - app kill
   - background
   - reinicio móvil
   - Drive
   - NAS
   - export
   - batería baja
   - red mala
   - uso por persona no técnica

Para cada prueba incluir:
- ID
- objetivo
- pasos
- resultado esperado
- logs esperados si aplica
- severidad si falla
- estado: pendiente / pasa / falla
- notas

Reglas:
- lenguaje claro
- formato markdown
- orientado a validación real
- no duplicar RELEASE_CHECKLIST
- no meter roadmap
- no meter features futuras

Prioridad:
demostrar supervivencia, claridad y confianza.