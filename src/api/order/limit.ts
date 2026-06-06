// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos los enums de Prisma para usar los tipos de Mercado y Dirección
import { Market, Side } from '@prisma/client';
// Importamos las utilidades para validaciones
import { validatePositiveNumber, validateLeverage, MAKER_FEE_PERCENT } from '@/lib/utils';

// Función handler para el endpoint POST /api/order/limit
export async function POST(req: NextRequest) {
  try {
    // Parseamos el body del request para obtener los datos de la orden limit
    const { walletAddress, market, side, leverage, margin, limitPrice, stopLossPrice, takeProfitPrice } = await req.json();

    // Validamos que el walletAddress esté presente
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Missing required field: walletAddress' },
        { status: 400 }
      );
    }

    // Validamos que el market esté presente
    if (!market) {
      return NextResponse.json(
        { error: 'Missing required field: market' },
        { status: 400 }
      );
    }

    // Validamos que el side esté presente
    if (!side) {
      return NextResponse.json(
        { error: 'Missing required field: side' },
        { status: 400 }
      );
    }

    // Validamos que el leverage esté presente
    if (!leverage) {
      return NextResponse.json(
        { error: 'Missing required field: leverage' },
        { status: 400 }
      );
    }

    // Validamos que el margin esté presente
    if (!margin) {
      return NextResponse.json(
        { error: 'Missing required field: margin' },
        { status: 400 }
      );
    }

    // Validamos que el limitPrice esté presente
    if (!limitPrice) {
      return NextResponse.json(
        { error: 'Missing required field: limitPrice' },
        { status: 400 }
      );
    }

    // Validamos que el margin sea positivo (bloqueo de números negativos)
    validatePositiveNumber(margin, 'margin');

    // Validamos que el leverage sea positivo (bloqueo de números negativos)
    validatePositiveNumber(leverage, 'leverage');

    // Validamos que el limitPrice sea positivo (bloqueo de números negativos)
    validatePositiveNumber(limitPrice, 'limitPrice');

    // Validamos el apalancamiento según el mercado (BTC/ETH <= 50, SPCX = 1)
    validateLeverage(market as Market, leverage);

    // Calculamos el sizeUsd obligatoriamente como margin * leverage (previene hack del tamaño)
    const sizeUsd = margin * leverage;

    // Calculamos la comisión Maker (0.02% del sizeUsd)
    const makerFee = sizeUsd * MAKER_FEE_PERCENT;

    // Calculamos el total a bloquear (Margen + Comisión Maker)
    const totalToLock = margin + makerFee;

    // Validaciones de Stop Loss si se proporciona
    if (stopLossPrice !== undefined && stopLossPrice !== null) {
      // Validamos que el stopLossPrice sea positivo
      if (stopLossPrice <= 0) {
        return NextResponse.json(
          { error: 'stopLossPrice must be greater than 0' },
          { status: 400 }
        );
      }
      // Validamos que el stopLossPrice no sea igual al limitPrice
      if (stopLossPrice === limitPrice) {
        return NextResponse.json(
          { error: 'stopLossPrice cannot be equal to limitPrice' },
          { status: 400 }
        );
      }
      // Validamos dirección del Stop Loss según el side
      if (side === 'LONG' && stopLossPrice >= limitPrice) {
        return NextResponse.json(
          { error: 'For LONG positions, stopLossPrice must be less than limitPrice' },
          { status: 400 }
        );
      }
      if (side === 'SHORT' && stopLossPrice <= limitPrice) {
        return NextResponse.json(
          { error: 'For SHORT positions, stopLossPrice must be greater than limitPrice' },
          { status: 400 }
        );
      }
    }

    // Validaciones de Take Profit si se proporciona
    if (takeProfitPrice !== undefined && takeProfitPrice !== null) {
      // Validamos que el takeProfitPrice sea positivo
      if (takeProfitPrice <= 0) {
        return NextResponse.json(
          { error: 'takeProfitPrice must be greater than 0' },
          { status: 400 }
        );
      }
      // Validamos que el takeProfitPrice no sea igual al limitPrice
      if (takeProfitPrice === limitPrice) {
        return NextResponse.json(
          { error: 'takeProfitPrice cannot be equal to limitPrice' },
          { status: 400 }
        );
      }
      // Validamos dirección del Take Profit según el side
      if (side === 'LONG' && takeProfitPrice <= limitPrice) {
        return NextResponse.json(
          { error: 'For LONG positions, takeProfitPrice must be greater than limitPrice' },
          { status: 400 }
        );
      }
      if (side === 'SHORT' && takeProfitPrice >= limitPrice) {
        return NextResponse.json(
          { error: 'For SHORT positions, takeProfitPrice must be less than limitPrice' },
          { status: 400 }
        );
      }
    }

    // Validación de relación lógica entre SL y TP si ambos se proporcionan
    if (stopLossPrice && takeProfitPrice) {
      if (side === 'LONG' && stopLossPrice >= takeProfitPrice) {
        return NextResponse.json(
          { error: 'For LONG positions, stopLossPrice must be less than takeProfitPrice' },
          { status: 400 }
        );
      }
      if (side === 'SHORT' && stopLossPrice <= takeProfitPrice) {
        return NextResponse.json(
          { error: 'For SHORT positions, stopLossPrice must be greater than takeProfitPrice' },
          { status: 400 }
        );
      }
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

      // Usamos Optimistic Concurrency Control: el where incluye la condición de saldo
      // Esto previene race conditions donde múltiples peticiones concurrentes podrían dejar el saldo en negativo
      const updatedUser = await tx.user.update({
        where: { 
          id: user.id,
          availableBalance: { gte: totalToLock } // ESTE ES EL CANDADO ANTI-RACE-CONDITION
        },
        data: {
          availableBalance: {
            decrement: totalToLock
          }
        }
      });

      // Si el update no afectó ninguna fila (saldo insuficiente), Prisma lanza error
      // Esto es manejado por el bloque catch

      // Creamos la orden pendiente con sizeUsd calculado y SL/TP si se proporcionaron
      const pendingOrder = await tx.pendingOrder.create({
        data: {
          userId: user.id,
          market: market as Market,
          side: side as Side,
          leverage,
          margin,
          sizeUsd,
          limitPrice,
          stopLossPrice: stopLossPrice || null,
          takeProfitPrice: takeProfitPrice || null
        }
      });

      // Retornamos la orden pendiente y el usuario actualizado
      return { pendingOrder, updatedUser };
    });

    // Retornamos respuesta exitosa con la orden pendiente y el nuevo balance
    return NextResponse.json({
      success: true,
      pendingOrder: result.pendingOrder,
      newBalance: result.updatedUser.availableBalance
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Limit order error:', error);
    
    // Si el error es que el usuario no existe, retornamos 404
    if (error.message === 'User not found') {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Si el error es de Prisma por no encontrar el usuario con el saldo suficiente (race condition o saldo insuficiente)
    if (error.code === 'P2025') {
      return NextResponse.json(
        { error: 'Insufficient balance' },
        { status: 400 }
      );
    }

    // Si el error es de validación de números positivos o apalancamiento, retornamos 400
    if (error.message.includes('must be greater than 0') || error.message.includes('must be') || error.message.includes('Leverage for')) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
