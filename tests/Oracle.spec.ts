import { Blockchain, SandboxContract } from '@ton-community/sandbox';
import { toNano } from 'ton-core';
import { Oracle } from '../wrappers/Oracle';
import '@ton-community/test-utils';

describe('Oracle', () => {
    let blockchain: Blockchain;
    let oracle: SandboxContract<Oracle>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        oracle = blockchain.openContract(await Oracle.fromInit());

        const deployer = await blockchain.treasury('deployer');

        const deployResult = await oracle.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            }
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: oracle.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and oracle are ready to use
    });
});
