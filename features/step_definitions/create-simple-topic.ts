import { After, Given, Then, When } from "@cucumber/cucumber";
import {
  Client,
  AccountId,
  KeyList,
  Key,
  PrivateKey,
  TopicId,
  AccountBalanceQuery,
  TopicCreateTransaction,
  TopicMessageQuery,
  TopicMessageSubmitTransaction,
  AccountCreateTransaction,
  Hbar,
  AccountDeleteTransaction,
  TopicDeleteTransaction,
  Transaction,
  TransactionReceipt,
  PublicKey,
} from "@hashgraph/sdk";
import assert from "node:assert";
import { accounts, Account } from "../../src/config";

// Singleton client instance
const client = Client.forTestnet();

// Test context
interface TestContext {
  topicId?: TopicId;
  thresholdKey?: Key;
  firstAccount?: Account;
  secondAccount?: Account;
  createdResources: {
    topics: TopicId[];
    accounts: AccountId[];
  };
}

const context: TestContext = {
  createdResources: {
    topics: [],
    accounts: [],
  },
};

// Helper to execute transaction and get receipt with error handling
async function executeTransaction<T extends Transaction>(
  transaction: T
): Promise<TransactionReceipt> {
  try {
    const response = await transaction.execute(client);
    return await response.getReceipt(client);
  } catch (error) {
    console.error("Transaction failed:", error);
    throw error;
  }
}

// Optimized account creation with resource tracking
const createAccountWithHbar = async (hbarAmount: number): Promise<Account> => {
  const privateKey = PrivateKey.generateED25519();
  
  const receipt = await executeTransaction(
    new AccountCreateTransaction()
      .setKey(privateKey.publicKey)
      .setInitialBalance(new Hbar(hbarAmount))
  );

  const accountId = receipt.accountId!;
  context.createdResources.accounts.push(accountId);

  return {
    id: accountId.toString(),
    privateKey: privateKey.toString(),
  };
};

// Cached balance queries
const balanceCache = new Map<string, { balance: number; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds

const getHbarBalance = async (account: Account): Promise<number> => {
  const cached = balanceCache.get(account.id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.balance;
  }

  const accountId = AccountId.fromString(account.id);
  const balanceResult = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(client);
  
  const balance = balanceResult.hbars.toBigNumber().toNumber();
  balanceCache.set(account.id, { balance, timestamp: Date.now() });
  
  return balance;
};

// Optimized topic creation with better error handling
const createTopic = async (memo: string, submitKey?: Key): Promise<TopicId> => {
  const topicTx = new TopicCreateTransaction()
    .setAdminKey(client.operatorPublicKey!)
    .setTopicMemo(memo);

  if (submitKey) {
    topicTx.setSubmitKey(submitKey);
  }

  let frozenTx = await topicTx.freezeWith(client);

  // Sign if submitKey is a PrivateKey
  if (submitKey instanceof PrivateKey) {
    frozenTx = await frozenTx.sign(submitKey);
  }

  const receipt = await executeTransaction(frozenTx);
  const topicId = receipt.topicId!;
  
  context.createdResources.topics.push(topicId);
  return topicId;
};

// Batch message publishing for better performance
class MessagePublisher {
  private pendingMessages: Array<{
    message: string;
    topicId: TopicId;
    submitKey?: PrivateKey;
  }> = [];

  async publish(message: string, topicId: TopicId, submitKey?: PrivateKey): Promise<void> {
    this.pendingMessages.push({ message, topicId, submitKey });
    
    // Batch publish if we have enough messages
    if (this.pendingMessages.length >= 5) {
      await this.flushMessages();
    }
  }

  async flushMessages(): Promise<void> {
    const messages = [...this.pendingMessages];
    this.pendingMessages = [];

    await Promise.all(
      messages.map(async ({ message, topicId, submitKey }) => {
        let submitTx = new TopicMessageSubmitTransaction()
          .setTopicId(topicId)
          .setMessage(message)
          .freezeWith(client);

        if (submitKey) {
          submitTx = await submitTx.sign(submitKey);
        }

        const receipt = await executeTransaction(submitTx);
        console.log(`Message submitted to topic ${topicId}: ${receipt.status}`);
      })
    );
  }
}

const messagePublisher = new MessagePublisher();

// Single publish method for immediate execution
const publishMessage = async (
  message: string,
  topicId: TopicId,
  submitKey?: PrivateKey
): Promise<void> => {
  let submitTx = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .freezeWith(client);

  if (submitKey) {
    submitTx = await submitTx.sign(submitKey);
  }

  const receipt = await executeTransaction(submitTx);
  console.log("Message submit status:", receipt.status.toString());
};

// Improved topic subscription with timeout and error handling
const subscribeToTopic = (
  topicId: TopicId,
  expectedMessage: string,
  timeout: number = 10000
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for message: ${expectedMessage}`));
    }, timeout);

    const subscriptionHandle = new TopicMessageQuery()
      .setTopicId(topicId)
      .setStartTime(0)
      .subscribe(
        client,
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        (message) => {
          const decodedContent = Buffer.from(message.contents).toString();
          console.log("Received message:", decodedContent);
          
          if (decodedContent === expectedMessage) {
            clearTimeout(timeoutId);
            subscriptionHandle.unsubscribe();
            resolve();
          }
        }
      );
  });
};

// Helper to get private key from account
const getPrivateKey = (account: Account): PrivateKey => 
  PrivateKey.fromStringED25519(account.privateKey);

// Step Definitions

Given(/^a first account with more than (\d+) hbars$/, async function (minimumBalance: number) {
  // Try to find an existing account first
  const eligibleAccounts = await Promise.all(
    accounts.map(async (account) => ({
      account,
      balance: await getHbarBalance(account),
    }))
  );

  const suitable = eligibleAccounts.find(({ balance }) => balance > minimumBalance);
  
  if (suitable) {
    const { account } = suitable;
    const accountId = AccountId.fromString(account.id);
    const privateKey = getPrivateKey(account);
    
    client.setOperator(accountId, privateKey);
    context.firstAccount = account;
    return;
  }

  assert.fail(`No configured account had more than ${minimumBalance} HBAR.`);
});

When(/^A topic is created with the memo "([^"]*)" with the first account as the submit key$/, 
  async function (memo: string) {
    assert.ok(context.firstAccount, "First account not initialized");
    const firstPrivateKey = getPrivateKey(context.firstAccount);
    context.topicId = await createTopic(memo, firstPrivateKey);
    console.log("Topic created with ID:", context.topicId.toString());
  }
);

When(/^The message "([^"]*)" is published to the topic$/, async function (message: string) {
  assert.ok(context.firstAccount, "First account not initialized");
  assert.ok(context.topicId, "Topic not created");
  
  const firstPrivateKey = getPrivateKey(context.firstAccount);
  await publishMessage(message, context.topicId, firstPrivateKey);
});

Then(/^The message "([^"]*)" is received by the topic and can be printed to the console$/, 
  async function (expectedMessage: string) {
    assert.ok(context.topicId, "Topic not created");
    await subscribeToTopic(context.topicId, expectedMessage);
  }
);

Given(/^A second account with more than (\d+) hbars$/, async function (hbarThreshold: number) {
  context.secondAccount = await createAccountWithHbar(hbarThreshold);
});

Given(/^A (\d+) of (\d+) threshold key with the first and second account$/, 
  async function (requiredSigns: number, totalKeys: number) {
    assert.ok(context.firstAccount && context.secondAccount, "Accounts not initialized");
    
    const accountsInvolved = [context.firstAccount, context.secondAccount];
    const publicKeys = accountsInvolved
      .slice(0, totalKeys)
      .map((acc) => getPrivateKey(acc).publicKey);

    context.thresholdKey = new KeyList(publicKeys, requiredSigns);
  }
);

When(/^A topic is created with the memo "([^"]*)" with the threshold key as the submit key$/, 
  async function (memo: string) {
    assert.ok(context.secondAccount && context.thresholdKey, "Prerequisites not met");
    
    const secondPrivKey = getPrivateKey(context.secondAccount);
    const topicTx = await new TopicCreateTransaction()
      .setAdminKey(client.operatorPublicKey!)
      .setSubmitKey(context.thresholdKey)
      .setTopicMemo(memo)
      .freezeWith(client);

    const signedTx = await topicTx.sign(secondPrivKey);
    const receipt = await executeTransaction(signedTx);

    context.topicId = receipt.topicId!;
    context.createdResources.topics.push(context.topicId);
    console.log("Topic created with threshold key, ID:", context.topicId.toString());
  }
);

// Cleanup after tests
After(async function () {
  console.log("Cleaning up test resources...");
  
  // Flush any pending messages
  await messagePublisher.flushMessages();
  
  // Delete created topics
  for (const topicId of context.createdResources.topics) {
    try {
      await executeTransaction(
        new TopicDeleteTransaction()
          .setTopicId(topicId)
          .freezeWith(client)
      );
      console.log(`Deleted topic: ${topicId}`);
    } catch (error) {
      console.error(`Failed to delete topic ${topicId}:`, error);
    }
  }

  // Delete created accounts (transfer remaining balance back to operator)
  for (const accountId of context.createdResources.accounts) {
    try {
      // Note: In real implementation, you'd need the private key of the account
      // This is just a placeholder for the cleanup logic
      console.log(`Would delete account: ${accountId}`);
    } catch (error) {
      console.error(`Failed to delete account ${accountId}:`, error);
    }
  }

  // Clear resources
  context.createdResources.topics = [];
  context.createdResources.accounts = [];
  balanceCache.clear();
});

// Export for potential reuse
export { 
  context,
  executeTransaction,
  createAccountWithHbar,
  getHbarBalance,
  createTopic,
  publishMessage,
  subscribeToTopic,
  messagePublisher,
};