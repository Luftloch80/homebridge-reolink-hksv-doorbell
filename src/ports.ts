import { createSocket } from 'node:dgram';

function reserveUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

/**
 * Reserves N free local UDP ports by binding to port 0 (OS-assigned) and immediately
 * releasing them, one at a time so the OS can't hand out the same port twice in the
 * same batch. Used to pick local ports to advertise in HomeKit's SetupEndpoints
 * response for RTCP loopback.
 */
export async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(await reserveUdpPort());
  }
  return ports;
}
