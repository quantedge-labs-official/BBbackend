// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos las utilidades para validaciones
import { validatePositiveNumber } from '@/lib/utils';

// Función handler para el endpoint POST /api/withdraw
export async function POST(req: NextRequest) {
  try {
    // Parseamos el body del request para obtener los datos del retiro
    const { walletAddress, amount } = await req.json();

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

    // Validamos que el amount sea positivo (bloqueo de números negativos)
    validatePositiveNumber(amount, 'amount');

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

      // Si el amount es mayor a 10000, el retiro requiere aprobación manual
      if (amount > 10000) {
        // Creamos la solicitud de retiro con estado PENDING_REVIEW
        const withdrawal = await tx.withdrawalRequest.create({
          data: {
            userId: user.id,
            amount,
            status: 'PENDING_REVIEW'
          }
        });

        // Retornamos la solicitud de retiro creada
        return { withdrawal, user, requiresApproval: true };
      }

      // Para retiros menores o iguales a 10000, procesamos automáticamente
      // Usamos Optimistic Concurrency Control: el where incluye la condición de saldo
      // Esto previene race conditions donde múltiples peticiones concurrentes podrían dejar el saldo en negativo
      const updatedUser = await tx.user.update({
        where: { 
          id: user.id,
          availableBalance: { gte: amount } // ESTE ES EL CANDADO ANTI-RACE-CONDITION
        },
        data: {
          availableBalance: {
            decrement: amount
          }
        }
      });

      // Si el update no afectó ninguna fila (saldo insuficiente), Prisma lanza error
      // Esto es manejado por el bloque catch

      // Creamos la solicitud de retiro con estado COMPLETED
      const withdrawal = await tx.withdrawalRequest.create({
        data: {
          userId: user.id,
          amount,
          status: 'COMPLETED'
        }
      });

      // Retornamos el retiro completado y el usuario actualizado
      return { withdrawal, updatedUser, requiresApproval: false };
    });

    // Si el retiro requiere aprobación manual
    if (result.requiresApproval) {
      return NextResponse.json({
        success: true,
        withdrawal: result.withdrawal,
        requiresApproval: true,
        message: 'Withdrawal requires manual approval'
      });
    }

    // Retornamos respuesta exitosa con el retiro completado y el nuevo balance
    return NextResponse.json({
      success: true,
      withdrawal: result.withdrawal,
      newBalance: result.updatedUser.availableBalance
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Withdraw error:', error);
    
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
