import { describe, expect, it } from 'vitest';
import {
  applyDigitalEmployeeOrder,
  mergeDigitalEmployeeOrder,
  removeDigitalEmployeeIdFromOrder,
} from '../../src/lib/digital-employee-order';
import type { MyAgent } from '../../src/pages/DigitalEmployee/mock-data';

function createAgent(id: string, name: string): MyAgent {
  return {
    id,
    marketEmployeeId: id,
    sessionKey: `agent:${id}:main`,
    agentId: `employee-${id}`,
    packageId: `com.lyclaw.employee.${id}`,
    name,
    description: '',
    version: '1.0.0',
    author: 'Test',
    enabled: true,
    tags: [],
  };
}

describe('digital employee order helpers', () => {
  const agents = [
    createAgent('emp-a', 'Alpha'),
    createAgent('emp-b', 'Beta'),
    createAgent('emp-c', 'Gamma'),
  ];

  it('applies saved order and appends unknown agents', () => {
    expect(applyDigitalEmployeeOrder(agents, ['emp-c', 'emp-a']).map((agent) => agent.id)).toEqual([
      'emp-c',
      'emp-a',
      'emp-b',
    ]);
  });

  it('merges new agents to the end without disturbing existing order', () => {
    expect(mergeDigitalEmployeeOrder(['emp-b', 'emp-a'], agents)).toEqual(['emp-b', 'emp-a', 'emp-c']);
  });

  it('removes deleted agent ids from saved order', () => {
    expect(removeDigitalEmployeeIdFromOrder(['emp-a', 'emp-b', 'emp-c'], 'emp-b')).toEqual([
      'emp-a',
      'emp-c',
    ]);
  });
});
