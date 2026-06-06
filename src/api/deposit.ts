// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos las utilidades para validaciones
import { validatePositiveNumber } from '@/lib/utils';

// Función handler para el endpoint POST /api/deposit
export async function POST(req: NextRequest) {
  try {
    // Parseamos el body del request para obtener los datos del depósito
    const { walletAddress, amount, txHash } = await req.json();

    // Validamos que el walletAddress esté presente
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Missing required field: walletAddress' },
        { status: 400 }
      );
    }

    // Validamos que el amount esté presente
    if (!amount) {
      return NextResponse.json(
        { error: 'Missing required field: amount' },
        { status: 400 }
      );
    }

    // Validamos que el txHash esté presente
    if (!txHash) {
      return NextResponse.json(
        { error: 'Missing required field: txHash' },
        { status: 400 }
      );
    }

    // Validamos que el amount sea positivo (bloqueo de números negativos)
    validatePositiveNumber(amount, 'amount');

    // Ejecutamos una transacción atómica para garantizar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // Primero hacemos upsert del User por walletAddress para obtener su ID (fix de orden de creación)
      const user = await tx.user.upsert({
        where: { walletAddress },
        update: {},
        create: {
          walletAddress,
          availableBalance: 0
        }
      });

      // Creamos el depósito usando el ID del usuario obtenido
      const deposit = await tx.deposit.create({
        data: {
          userId: user.id,
          amount,
          txHash
        }
      });

      // Incrementamos el balance del usuario con el monto del depósito
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          availableBalance: {
            increment: amount
          }
        }
      });

      // Retornamos el depósito y el usuario actualizado
      return { deposit, updatedUser };
    });

    // Retornamos respuesta exitosa con el depósito y el nuevo balance
    return NextResponse.json({
      success: true,
      deposit: result.deposit,
      newBalance: result.updatedUser.availableBalance
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Deposit error:', error);
    
    // Si el error es de unicidad del txHash (ya existe), retornamos 400
    if (error.code === 'P2002') {
      return NextResponse.json(
        { error: 'Transaction hash already exists' },
        { status: 400 }
      );
    }

    // Si el error es de validación de números positivos, retornamos 400
    if (error.message.includes('must be greater than 0')) {
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
