/* ------------------------------------------------------------------------ */
/* Eve custom characteristics (power metering shows in the Eve app)          */
/* ------------------------------------------------------------------------ */
export function buildEveCharacteristics(hapRef) {
  const make = (name, uuid, unit, maxValue) => {
    const C = class extends hapRef.Characteristic {
      constructor() {
        super(name, uuid, {
          format: hapRef.Formats.FLOAT,
          unit,
          minValue: 0,
          maxValue,
          minStep: 0.01,
          perms: [hapRef.Perms.PAIRED_READ, hapRef.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    };
    C.UUID = uuid;
    return C;
  };
  return {
    Watts: make('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W', 100000),
    Volts: make('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V', 1000),
    Amps: make('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', 'A', 1000),
    KWh: make('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh', 1000000),
  };
}
