import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    // Includes IPv4-mapped IPv6, NAT64, documentation, multicast and reserved ranges.
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function parseTarget(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('URL inválida');
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || (target.port && target.port !== (target.protocol === 'https:' ? '443' : '80')))
    throw new Error('Solo se permiten URLs públicas HTTP(S) en sus puertos estándar');
  target.hash = '';
  return target;
}

export async function resolvePublicTarget(value, lookup = dns.lookup) {
  const target = parseTarget(value);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicAddress(address)))
    throw new Error('El destino no tiene exclusivamente direcciones públicas');
  return { target, address: records[0].address, family: records[0].family };
}
