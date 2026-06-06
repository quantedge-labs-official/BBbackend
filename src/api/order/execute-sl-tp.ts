// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos el middleware para validar el API_SECRET_KEY
import { validateApiSecret } from '@/lib/middleware';
// Importamos las utilidades para slippage, fees y cálculos
import { applyExitSlippage, TAKER_FEE_PERCENT, calculatePnL } from '@/lib/utils';

// Función handler para el endpoint POST /api/order/execute-sl-tp (PROTEGIDO)
export async function POST(req: NextRequest) {
  // Validamos el API_SECRET_KEY en los headers (protección contra llamadas no autorizadas)
  const authError = validateApiSecret(req);
  // Si hay error de autenticación, retornamos la respuesta de error
  if (authError) return authError;

  try {
    // Parseamos el body del request para obtener los datos de ejecución
    const { positionId, currentPrice, closeReason } = await req.json();

    // Validamos que el positionId esté presente
    if (!positionId) {
      return NextResponse.json(
        { error: 'Missing required field: positionId' },
        { status: 400 }
      );
    }

    // Validamos que el currentPrice esté presente
    if (!currentPrice) {
      return NextResponse.json(
        { error: 'Missing required field: currentPrice' },
        { status: 400 }
      );
    }

    // Validamos que el closeReason esté presente
    if (!closeReason) {
      return NextResponse.json(
        { error: 'Missing required field: closeReason' },
        { status: 400 }
      );
    }

    // Validamos que el currentPrice sea positivo (bloqueo de números negativos)
    if (currentPrice <= 0) {
      return NextResponse.json(
        { error: 'currentPrice must be greater than 0' },
        { status: 400 }
      );
    }

    // Ejecutamos una transacción atómica para garantizar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // Buscamos la posición por su ID
      const position = await tx.position.findUnique({
        where: { id: positionId }
      });

      // Si la posición no existe, lanzamos error
      if (!position) {
        throw new Error('Position not found');
      }

      // Aplicamos slippage al precio de salida (empeora el precio a favor del broker)
      const closePrice = applyExitSlippage(currentPrice, position.side);

      // Calculamos el PnL usando la nueva fórmula con sizeUsd
      const pnl = calculatePnL(
        Number(position.entryPrice),
        closePrice,
        Number(position.sizeUsd),
        position.side
      );

      // Calculamos la comisión Taker (0.03% del sizeUsd, sin multiplicar por closePrice)
      const commission = Number(position.sizeUsd) * TAKER_FEE_PERCENT;

      // Calculamos el retorno al usuario (Margen + PnL - Comisión)
      const returnAmount = Number(position.margin) + pnl - commission;

      // Topamos el retorno a 0 para evitar saldos negativos
      const finalReturnAmount = Math.max(0, returnAmount);

      // Topamos el PnL en TradeHistory a la pérdida máxima (-margin) para evitar discrepancias contables
      const cappedPnl = Math.max(pnl, -Number(position.margin));

      // Actualizamos el balance del usuario con el retorno topeado
      await tx.user.update({
        where: { id: position.userId },
        data: {
          availableBalance: {
            increment: finalReturnAmount
          }
        }
      });

      // Creamos el registro en TradeHistory con sizeUsd y PnL topeado
      const tradeHistory = await tx.tradeHistory.create({
        data: {
          userId: position.userId,
          market: position.market,
          side: position.side,
          sizeUsd: position.sizeUsd,
          entryPrice: position.entryPrice,
          closePrice,
          pnl: cappedPnl,
          closeReason
        }
      });

      // Borramos la posición
      await tx.position.delete({
        where: { id: positionId }
      });

      // Retornamos el tradeHistory, el PnL topeado y el precio de cierre
      return { tradeHistory, pnl: cappedPnl, closePrice };
    });

    // Retornamos respuesta exitosa con el tradeHistory, PnL topeado y precio de cierre
    return NextResponse.json({
      success: true,
      tradeHistory: result.tradeHistory,
      pnl: result.pnl,
      closePrice: result.closePrice
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Execute SL/TP error:', error);
    
    // Si el error es que la posición no existe, retornamos 404
    if (error.message === 'Position not found') {
      return NextResponse.json(
        { error: 'Position not found' },
        { status: 404 }
      );
    }

    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
