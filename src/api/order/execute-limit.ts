// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos el middleware para validar el API_SECRET_KEY
import { validateApiSecret } from '@/lib/middleware';
// Importamos los enums de Prisma para usar los tipos de Mercado y Dirección
import { Market, Side } from '@prisma/client';
// Importamos las utilidades para slippage y cálculos
import { applySlippage, calculateLiquidationPrice } from '@/lib/utils';

// Función handler para el endpoint POST /api/order/execute-limit (PROTEGIDO)
export async function POST(req: NextRequest) {
  // Validamos el API_SECRET_KEY en los headers (protección contra llamadas no autorizadas)
  const authError = validateApiSecret(req);
  // Si hay error de autenticación, retornamos la respuesta de error
  if (authError) return authError;

  try {
    // Parseamos el body del request para obtener los datos de ejecución
    const { pendingOrderId, currentPrice } = await req.json();

    // Validamos que el pendingOrderId esté presente
    if (!pendingOrderId) {
      return NextResponse.json(
        { error: 'Missing required field: pendingOrderId' },
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
      // Buscamos la orden pendiente por su ID
      const pendingOrder = await tx.pendingOrder.findUnique({
        where: { id: pendingOrderId }
      });

      // Si la orden pendiente no existe, lanzamos error
      if (!pendingOrder) {
        throw new Error('Pending order not found');
      }

      // Aplicamos slippage al precio límite (no al currentPrice) para ejecutar al precio pactado
      const entryPrice = applySlippage(Number(pendingOrder.limitPrice), pendingOrder.side);

      // Calculamos el precio de liquidación usando la nueva fórmula con leverage
      const liquidationPrice = calculateLiquidationPrice(
        entryPrice,
        pendingOrder.leverage,
        pendingOrder.side
      );

      // Creamos la posición moviendo la orden pendiente a una posición real, incluyendo SL/TP
      const position = await tx.position.create({
        data: {
          userId: pendingOrder.userId,
          market: pendingOrder.market,
          side: pendingOrder.side,
          leverage: pendingOrder.leverage,
          margin: pendingOrder.margin,
          sizeUsd: pendingOrder.sizeUsd,
          entryPrice,
          liquidationPrice,
          stopLossPrice: pendingOrder.stopLossPrice,
          takeProfitPrice: pendingOrder.takeProfitPrice
        }
      });

      // NO volvemos a restar la comisión aquí (ya fue restada al crear la orden limit)
      // Solo movemos la orden de PendingOrder a Position

      // Borramos la orden pendiente
      await tx.pendingOrder.delete({
        where: { id: pendingOrderId }
      });

      // Retornamos la posición creada
      return { position };
    });

    // Retornamos respuesta exitosa con la posición creada
    return NextResponse.json({
      success: true,
      position: result.position
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Execute limit order error:', error);
    
    // Si el error es que la orden no existe, retornamos 404
    if (error.message === 'Pending order not found') {
      return NextResponse.json(
        { error: 'Pending order not found' },
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
