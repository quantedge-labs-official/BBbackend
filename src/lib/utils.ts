// Definimos el porcentaje de slippage (0.01% = 0.0001)
const SLIPPAGE_PERCENT = 0.0001;
// Definimos el porcentaje de comisión Taker (0.03% = 0.0003)
export const TAKER_FEE_PERCENT = 0.0003;
// Definimos el porcentaje de comisión Maker (0.02% = 0.0002)
export const MAKER_FEE_PERCENT = 0.0002;

// Función para aplicar slippage al precio de entrada (empeora el precio a favor del broker)
export function applySlippage(price: number, side: 'LONG' | 'SHORT'): number {
  // Si la posición es LONG, el slippage aumenta el precio de entrada (el usuario entra más caro)
  if (side === 'LONG') {
    return price * (1 + SLIPPAGE_PERCENT);
  }
  // Si la posición es SHORT, el slippage disminuye el precio de entrada (el usuario entra más barato)
  return price * (1 - SLIPPAGE_PERCENT);
}

// Función para aplicar slippage al precio de salida (empeora el precio a favor del broker)
export function applyExitSlippage(price: number, side: 'LONG' | 'SHORT'): number {
  // Si la posición es LONG, el slippage disminuye el precio de salida (el usuario sale más barato)
  if (side === 'LONG') {
    return price * (1 - SLIPPAGE_PERCENT);
  }
  // Si la posición es SHORT, el slippage aumenta el precio de salida (el usuario sale más caro)
  return price * (1 + SLIPPAGE_PERCENT);
}

// Función para calcular el precio de liquidación usando la nueva fórmula con leverage
export function calculateLiquidationPrice(entryPrice: number, leverage: number, side: 'LONG' | 'SHORT'): number {
  // Si la posición es LONG, el precio de liquidación es: entryPrice * (1 - (0.90 / leverage))
  // El 0.90 representa el 90% del margen que se puede perder antes de liquidar
  if (side === 'LONG') {
    return entryPrice * (1 - (0.90 / leverage));
  }
  // Si la posición es SHORT, el precio de liquidación es: entryPrice * (1 + (0.90 / leverage))
  return entryPrice * (1 + (0.90 / leverage));
}

// Función para calcular el PnL usando la nueva fórmula con sizeUsd
export function calculatePnL(entryPrice: number, closePrice: number, sizeUsd: number, side: 'LONG' | 'SHORT'): number {
  // Si la posición es LONG, el PnL es: sizeUsd * ((closePrice - entryPrice) / entryPrice)
  if (side === 'LONG') {
    return sizeUsd * ((closePrice - entryPrice) / entryPrice);
  }
  // Si la posición es SHORT, el PnL es: sizeUsd * ((entryPrice - closePrice) / entryPrice)
  return sizeUsd * ((entryPrice - closePrice) / entryPrice);
}

// Función para validar que un número sea positivo (bloqueo de números negativos)
export function validatePositiveNumber(value: any, fieldName: string): void {
  // Convertimos el valor a número
  const num = Number(value);
  // Si el número es menor o igual a 0, lanzamos error
  if (num <= 0) {
    throw new Error(`${fieldName} must be greater than 0`);
  }
}

// Función para validar el apalancamiento según el mercado
export function validateLeverage(market: string, leverage: number): void {
  // Si el mercado es BTC_USD o ETH_USD, el apalancamiento debe estar entre 1 y 50
  if (market === 'BTC_USD' || market === 'ETH_USD') {
    if (leverage < 1 || leverage > 50) {
      throw new Error(`Leverage for ${market} must be between 1 and 50`);
    }
  }
  // Si el mercado es SPCX, el apalancamiento debe ser exactamente 1
  if (market === 'SPCX') {
    if (leverage !== 1) {
      throw new Error(`Leverage for SPCX must be exactly 1`);
    }
  }
}
