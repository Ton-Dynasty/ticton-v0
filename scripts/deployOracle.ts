import { toNano } from 'ton-core';
import { Oracle } from '../wrappers/Oracle';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const oracle = provider.open(await Oracle.fromInit());

    await oracle.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        {
            $$type: 'Deploy',
            queryId: 0n,
        }
    );

    await provider.waitForDeploy(oracle.address);

    // run methods on `oracle`
}
