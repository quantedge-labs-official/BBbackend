// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos las utilidades para slippage, fees y cálculos
import { applyExitSlippage, TAKER_FEE_PERCENT, calculatePnL } from '@/lib/utils';

// Función handler para el endpoint POST /api/order/close
export async function POST(req: NextRequest) {
  try {
    // Parseamos el body del request para obtener los datos del cierre
    const { walletAddress, positionId, currentPrice } = await req.json();

    // Validamos que el walletAddress esté presente
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Missing required field: walletAddress' },
        { status: 400 }
      );
    }

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

    // Validamos que el currentPrice sea positivo (bloqueo de números negativos)
    if (currentPrice <= 0) {
      return NextResponse.json(
        { error: 'currentPrice must be greater than 0' },
        { status: 400 }
      );
    }

    // Ejecutamos una transacción atómica para garantizar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // Buscamos el usuario por walletAddress
      const user = await tx.user.findUnique({
        where: { walletAddress }
      });

      // Si el usuario no existe, lanzamos error
      if (!user) {
        throw new Error('User not found');
      }

      // Buscamos la posición por su ID
      const position = await tx.position.findUnique({
        where: { id: positionId }
      });

      // Si la posición no existe, lanzamos error
      if (!position) {
        throw new Error('Position not found');
      }

      // Verificamos que la posición pertenezca al usuario
      if (position.userId !== user.id) {
        throw new Error('Unauthorized');
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
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          availableBalance: {
            increment: finalReturnAmount
          }
        }
      });

      // Creamos el registro en TradeHistory con sizeUsd y PnL topeado
      const tradeHistory = await tx.tradeHistory.create({
        data: {
          userId: user.id,
          market: position.market,
          side: position.side,
          sizeUsd: position.sizeUsd,
          entryPrice: position.entryPrice,
          closePrice,
          pnl: cappedPnl,
          closeReason: 'CLOSED'
        }
      });

      // Borramos la posición
      await tx.position.delete({
        where: { id: positionId }
      });

      // Retornamos el tradeHistory, el usuario actualizado, el PnL topeado y el precio de cierre
      return { tradeHistory, updatedUser, pnl: cappedPnl, closePrice };
    });

    // Retornamos respuesta exitosa con el tradeHistory, nuevo balance, PnL topeado y precio de cierre
    return NextResponse.json({
      success: true,
      tradeHistory: result.tradeHistory,
      newBalance: result.updatedUser.availableBalance,
      pnl: result.pnl,
      closePrice: result.closePrice
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Close position error:', error);
    
    // Si el error es que el usuario no existe, retornamos 404
    if (error.message === 'User not found') {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Si el error es que la posición no existe, retornamos 404
    if (error.message === 'Position not found') {
      return NextResponse.json(
        { error: 'Position not found' },
        { status: 404 }
      );
    }
    
    // Si el error es de autorización, retornamos 403
    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 403 }
      );
    }

    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
