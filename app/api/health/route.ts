import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    service: 'provenonce-beats',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}
