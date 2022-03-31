import { osmoDenomToSymbol, symbolToOsmoDenom } from '..';
import { prompt } from '../utils/prompt';
import { CosmosApiClient } from '../clients/cosmos';
import {
  baseUnitsToDisplayUnits,
  displayUnitsToDenomUnits,
  getCosmosAssetInfoByDenom,
  getWalletFromMnemonic,
  getBaseAndDisplayUnitsByDenom,
  baseUnitsToDisplayUnitsByDenom,
  getCosmosAssetInfo
} from '../utils';
import { promptChain, promptMnemonic } from '../utils/prompt';
import {
  SigningStargateClient,
  calculateFee,
  assertIsDeliverTxSuccess,
  GasPrice
} from '@cosmjs/stargate';
import { messages } from '../messages/native';
import { Dec } from '@keplr-wallet/unit';

export default async (argv) => {
  argv = await promptMnemonic(argv);
  const chain = await promptChain(argv);

  const { minAmount } = await prompt(
    [
      {
        type: 'number',
        message: 'minAmount',
        name: 'minAmount'
      }
    ],
    argv
  );

  const { restEndpoint } = await prompt(
    [
      {
        type: 'list',
        message: 'restEndpoint',
        name: 'restEndpoint',
        choices: chain.apis.rest.map((e) => e.address)
      }
    ],
    argv
  );

  const client = new CosmosApiClient({
    url: restEndpoint
  });

  // check re-stake (w display or base?)
  const denom = getCosmosAssetInfo(argv.chainToken).assets.find(
    (a) => a.symbol === argv.chainToken
  ).base;
  if (!denom) throw new Error('cannot find asset base unit');
  const defaultGasPrice = '0.0025' + denom;

  const signer = await getWalletFromMnemonic({
    mnemonic: argv.mnemonic,
    token: argv.chainToken
  });

  const { rpcEndpoint } = await prompt(
    [
      {
        type: 'list',
        message: 'rpcEndpoint',
        name: 'rpcEndpoint',
        choices: chain.apis.rpc.map((e) => e.address)
      }
    ],
    argv
  );

  const stargateClient = await SigningStargateClient.connectWithSigner(
    rpcEndpoint,
    signer
  );

  const getFee = (gas, gasPrice) => {
    if (!gas) gas = 200_000;
    if (!gasPrice) gasPrice = GasPrice.fromString(defaultGasPrice);
    return calculateFee(gas, gasPrice);
  };

  const [mainAccount] = await signer.getAccounts();

  const { address } = mainAccount;

  const delegations = await client.getDelegations(address);

  if (!delegations.result || !delegations.result.length) {
    console.log('no delegations. Exiting.');
  }

  const messagesToClaim = [];
  let totalClaimable = new Dec(0);

  const rewards = await client.getRewards(address);
  if (rewards && rewards.rewards && rewards.rewards.length) {
    rewards.rewards.forEach((data) => {
      const { validator_address, reward } = data;

      if (reward && reward.length) {
        // question for later: why does reward array have other coins like ATOM in it? (for OSMO).
        const rewardWeWant = reward.find((r) => r.denom === denom);
        if (!rewardWeWant) return;

        const value = baseUnitsToDisplayUnitsByDenom(
          rewardWeWant.denom,
          rewardWeWant.amount
        );
        totalClaimable = totalClaimable.add(new Dec(value));

        messagesToClaim.push(
          messages.withdrawDelegatorReward({
            delegatorAddress: address,
            validatorAddress: validator_address
          })
        );
      }
    });
  }

  if (!messagesToClaim.length) {
    console.log('no rewards. Exiting.');
    return;
  }

  const simulate = async (address, msgs, memo, modifier) => {
    const estimate = await stargateClient.simulate(address, msgs, memo);
    // console.log({ estimate })
    return parseInt(estimate * (modifier || 1.5));
  };

  const getGasPrice = async (address, msgs, memo, modifier) => {
    let fee;
    let gas;
    try {
      gas = await simulate(address, msgs, memo);
      fee = getFee(gas);
      //   fee = getFee(gas, gasPrice)
      return fee;
      //   const feeAmount = Number(fee.amount[0].amount);
      //   return feeAmount;
    } catch (error) {
      console.log(error);
    }
  };

  const fee = await getGasPrice(address, messagesToClaim);

  if (denom === 'uhuahua') {
    // literally wtf (needs a 10x + 1)
    fee.amount[0].amount = `${fee.amount[0].amount}1`;
  }
  if (denom === 'ucmdx') {
    // literally wtf (needs a 10x + 1)
    fee.amount[0].amount = `${fee.amount[0].amount}1`;
  }

  if (argv.simulate) {
    console.log(JSON.stringify(messagesToClaim, null, 2));
    console.log(JSON.stringify(fee, null, 2));
    return;
  }

  if (totalClaimable.gte(new Dec(minAmount))) {
    console.log(
      `${totalClaimable} ${argv.chainToken} available, starting claim process...`
    );
    stargateClient.signAndBroadcast(address, messagesToClaim, fee, '').then(
      (result) => {
        try {
          assertIsDeliverTxSuccess(result);
          stargateClient.disconnect();
          console.log('⚛️');
          console.log(
            `success in claiming ${totalClaimable.toString()} ${
              argv.chainToken
            } rewards`
          );
        } catch (error) {
          console.log(error);
        }
      },
      (error) => {
        console.log(error);
      }
    );
  } else {
    console.log(
      `${minAmount} not available (${totalClaimable.toString()} < minAmount)`
    );
  }
};