Contenido mínimo:

# Guardian Cloud — Change Guardrails

Antes de aceptar cualquier cambio:

- [ ] No toca GC_QUEUE salvo justificación explícita
- [ ] No toca upload worker salvo bug demostrado
- [ ] No cambia estados sin actualizar APP_STATES.md
- [ ] No mete lógica de negocio en UI
- [ ] No añade pasos antes de grabar
- [ ] No rompe recovery
- [ ] No rompe background upload
- [ ] No muestra términos técnicos al usuario
- [ ] Pasa test manual de grabar → mala red → cerrar app → recuperar
