// State Management
const state = {
    account: null,
    provider: null,
    ws: null,
    currentRequest: null,
    chainId: null,
    chainName: null,
    balance: null
};

// Chain configurations (wallet providers will use their default RPCs)
const CHAIN_CONFIGS = {
    'mainnet': { chainId: '0x1', name: 'Ethereum', explorer: 'https://etherscan.io' },
    'arbitrum': { chainId: '0xa4b1', name: 'Arbitrum', explorer: 'https://arbiscan.io' },
    'avalanche': { chainId: '0xa86a', name: 'Avalanche', explorer: 'https://snowtrace.io' },
    'base': { chainId: '0x2105', name: 'Base', explorer: 'https://basescan.org' },
    'bnb': { chainId: '0x38', name: 'BNB Chain', explorer: 'https://bscscan.com' },
    'gnosis': { chainId: '0x64', name: 'Gnosis', explorer: 'https://gnosisscan.io' },
    'sonic': { chainId: '0x92', name: 'Sonic', explorer: 'https://sonicscan.org' },
    'optimism': { chainId: '0xa', name: 'Optimism', explorer: 'https://optimistic.etherscan.io' },
    'polygon': { chainId: '0x89', name: 'Polygon', explorer: 'https://polygonscan.com' },
    'zksync': { chainId: '0x144', name: 'zkSync Era', explorer: 'https://explorer.zksync.io' },
    'linea': { chainId: '0xe708', name: 'Linea', explorer: 'https://lineascan.build' },
    'unichain': { chainId: '0x82', name: 'Unichain', explorer: 'https://unichain.org' }
};

// Transaction History Manager
class TransactionHistory {
    constructor() {
        this.storageKey = 'web3_tx_history';
        this.maxItems = 20;
    }

    getAll() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('Failed to load transaction history:', e);
            return [];
        }
    }

    add(tx) {
        const history = this.getAll();
        history.unshift({
            ...tx,
            timestamp: Date.now()
        });

        // Keep only recent transactions
        if (history.length > this.maxItems) {
            history.length = this.maxItems;
        }

        localStorage.setItem(this.storageKey, JSON.stringify(history));
        this.render();
    }

    render() {
        const history = this.getAll();
        const container = document.getElementById('txHistoryList');
        const historySection = document.getElementById('txHistory');

        if (history.length === 0) {
            historySection.classList.add('hidden');
            return;
        }

        historySection.classList.remove('hidden');
        container.innerHTML = history.map(tx => this.renderItem(tx)).join('');
    }

    renderItem(tx) {
        const date = new Date(tx.timestamp).toLocaleString();
        const statusClass = tx.status || 'pending';
        const explorerUrl = this.getExplorerUrl(tx.chain, tx.hash);

        return `
            <div class="tx-history-item ${statusClass}">
                <div class="tx-history-header">
                    <span class="tx-history-function">${tx.function || 'Transaction'}</span>
                    <span class="tx-history-status ${statusClass}">${statusClass.toUpperCase()}</span>
                </div>
                <div class="tx-history-details">
                    <div>${tx.chain} • ${date}</div>
                    ${tx.contract ? `<div>Contract: ${this.formatAddress(tx.contract)}</div>` : ''}
                </div>
                ${tx.hash ? `<a href="${explorerUrl}" target="_blank" class="tx-history-link">View on Explorer →</a>` : ''}
            </div>
        `;
    }

    formatAddress(addr) {
        return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
    }

    getExplorerUrl(chainName, txHash) {
        const config = CHAIN_CONFIGS[chainName];
        return config ? `${config.explorer}/tx/${txHash}` : `https://etherscan.io/tx/${txHash}`;
    }
}

const txHistory = new TransactionHistory();

// Error Message Parser
function parseError(error) {
    const message = error.message || String(error);

    // User rejected
    if (message.includes('User rejected') || message.includes('User denied')) {
        return {
            title: 'Transaction Rejected',
            message: 'You rejected the transaction in your wallet.',
            type: 'warning'
        };
    }

    // Insufficient funds
    if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
        return {
            title: 'Insufficient Balance',
            message: 'Your wallet does not have enough funds to complete this transaction. Please add funds and try again.',
            type: 'error'
        };
    }

    // Gas estimation failed
    if (message.includes('gas') && message.includes('estimation')) {
        return {
            title: 'Gas Estimation Failed',
            message: 'Unable to estimate gas for this transaction. The transaction may fail or the contract may have restrictions.',
            type: 'error'
        };
    }

    // Network error
    if (message.includes('network') || message.includes('connection')) {
        return {
            title: 'Network Error',
            message: 'Failed to connect to the network. Please check your internet connection and try again.',
            type: 'error'
        };
    }

    // Chain mismatch
    if (message.includes('chain')) {
        return {
            title: 'Wrong Network',
            message: 'Please switch to the correct network in your wallet.',
            type: 'warning'
        };
    }

    // Default
    return {
        title: 'Transaction Failed',
        message: message.length > 100 ? message.substring(0, 100) + '...' : message,
        type: 'error'
    };
}

// UI Functions
function showStatus(title, message, type = 'info') {
    const statusEl = document.getElementById('statusMessage');
    statusEl.className = `status ${type}`;
    statusEl.innerHTML = `<strong>${title}:</strong> ${message}`;
    statusEl.classList.remove('hidden');

    if (type === 'success' || type === 'info') {
        setTimeout(() => statusEl.classList.add('hidden'), 5000);
    }
}

function updateChainBadge(connected = false, chainName = 'Not Connected') {
    const badge = document.getElementById('chainBadge');
    const indicator = badge.querySelector('.chain-indicator');
    const nameSpan = document.getElementById('chainName');

    if (connected) {
        badge.classList.add('connected');
        indicator.classList.add('active');
        nameSpan.textContent = chainName;
    } else {
        badge.classList.remove('connected');
        indicator.classList.remove('active');
        nameSpan.textContent = chainName;
    }
}

function toggleChainDropdown(event) {
    event.stopPropagation();

    if (!state.account) {
        showStatus('Connect Wallet', 'Please connect your wallet first.', 'warning');
        return;
    }

    const badge = document.getElementById('chainBadge');
    const dropdown = document.getElementById('chainDropdown');

    badge.classList.toggle('open');
    dropdown.classList.toggle('show');

    // Populate dropdown if empty
    if (dropdown.children.length === 0) {
        populateChainDropdown();
    }
}

function populateChainDropdown() {
    const dropdown = document.getElementById('chainDropdown');
    dropdown.innerHTML = '';

    Object.entries(CHAIN_CONFIGS).forEach(([key, config]) => {
        const option = document.createElement('div');
        option.className = 'chain-option';
        option.textContent = config.name;
        option.onclick = () => selectChain(key);

        // Mark current chain as active
        if (state.chainId === config.chainId) {
            option.classList.add('active');
        }

        dropdown.appendChild(option);
    });
}

async function selectChain(chainName) {
    const dropdown = document.getElementById('chainDropdown');
    const badge = document.getElementById('chainBadge');

    dropdown.classList.remove('show');
    badge.classList.remove('open');

    if (chainName === Object.keys(CHAIN_CONFIGS).find(k => CHAIN_CONFIGS[k].chainId === state.chainId)) {
        return; // Already on this chain
    }

    await switchToChain(chainName);
}

// Close dropdown when clicking outside
document.addEventListener('click', () => {
    const dropdown = document.getElementById('chainDropdown');
    const badge = document.getElementById('chainBadge');
    if (dropdown && dropdown.classList.contains('show')) {
        dropdown.classList.remove('show');
        badge.classList.remove('open');
    }
});

function log(message, type = 'info') {
    const logEl = document.getElementById('log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

// Wallet Functions

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark ? 'true' : 'false');

    // Update button icon
    const button = document.querySelector('.dark-mode-toggle');
    button.textContent = isDark ? '☀️' : '🌙';
}

// Load dark mode preference on startup
// Priority: localStorage > system preference
const savedDarkMode = localStorage.getItem('darkMode');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const shouldUseDarkMode = savedDarkMode !== null ? savedDarkMode === 'true' : prefersDark;

if (shouldUseDarkMode) {
    document.body.classList.add('dark-mode');
    // Save the initial preference if not already saved
    if (savedDarkMode === null) {
        localStorage.setItem('darkMode', 'true');
    }
}

// Update button icon to match current state
const button = document.querySelector('.dark-mode-toggle');
if (button) {
    button.textContent = shouldUseDarkMode ? '☀️' : '🌙';
}

async function connectWallet() {
    try {
        // Prioritize Rabby over MetaMask
        let selectedProvider = null;
        let walletName = 'Web3 Wallet';

        if (window.rabby) {
            selectedProvider = window.rabby;
            walletName = 'Rabby';
        } else if (window.ethereum) {
            if (window.ethereum.isRabby) {
                selectedProvider = window.ethereum;
                walletName = 'Rabby';
            } else if (window.ethereum.isMetaMask) {
                selectedProvider = window.ethereum;
                walletName = 'MetaMask';
            } else {
                selectedProvider = window.ethereum;
            }
        } else {
            showStatus('No Wallet Found', 'Please install Rabby or MetaMask wallet.', 'error');
            return;
        }

        log(`Requesting ${walletName} connection...`, 'info');
        const accounts = await selectedProvider.request({
            method: 'eth_requestAccounts'
        });

        state.account = accounts[0];
        state.provider = selectedProvider;

        if (!window.ethereum) {
            window.ethereum = selectedProvider;
        }

        log(`Connected to ${walletName}: ${state.account}`, 'success');

        // Save connection state
        localStorage.setItem('walletConnected', 'true');
        localStorage.setItem('walletAddress', state.account);

        // Update UI - hide connect button
        document.getElementById('connectBtn').classList.add('hidden');

        await updateWalletInfo();
        connectWebSocket();
        txHistory.render();

        // Listen for account changes
        state.provider.on('accountsChanged', (accounts) => {
            if (accounts.length === 0) {
                log('Wallet disconnected', 'error');
                localStorage.removeItem('walletConnected');
                localStorage.removeItem('walletAddress');
                location.reload();
            } else {
                state.account = accounts[0];
                localStorage.setItem('walletAddress', state.account);
                updateWalletInfo();
            }
        });

        // Listen for chain changes
        state.provider.on('chainChanged', () => {
            log('Chain changed, reloading...', 'info');
            location.reload();
        });

        showStatus('Connected', `Wallet connected successfully`, 'success');

    } catch (error) {
        const err = parseError(error);
        log(`Connection failed: ${err.message}`, 'error');
        showStatus(err.title, err.message, err.type);
    }
}

async function updateWalletInfo() {
    try {
        state.chainId = await window.ethereum.request({ method: 'eth_chainId' });
        const balance = await window.ethereum.request({
            method: 'eth_getBalance',
            params: [state.account, 'latest']
        });

        state.balance = parseInt(balance, 16) / 1e18;

        // Find chain name
        state.chainName = Object.entries(CHAIN_CONFIGS).find(
            ([_, config]) => config.chainId === state.chainId
        )?.[1]?.name || `Chain ${parseInt(state.chainId, 16)}`;

        // Update UI
        document.getElementById('address').textContent = `${state.account.substring(0, 6)}...${state.account.substring(state.account.length - 4)}`;
        document.getElementById('networkName').textContent = `${state.chainName} (${parseInt(state.chainId, 16)})`;
        document.getElementById('balance').textContent = `${state.balance.toFixed(4)} ETH`;
        document.getElementById('walletInfo').classList.remove('hidden');

        updateChainBadge(true, state.chainName);
    } catch (error) {
        log(`Failed to update wallet info: ${error.message}`, 'error');
    }
}

// Chain Switching
async function switchToChain(chainName) {
    try {
        const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
        const targetChain = CHAIN_CONFIGS[chainName];

        if (!targetChain) {
            log(`Unknown chain: ${chainName}`, 'error');
            return;
        }

        if (currentChainId === targetChain.chainId) {
            log(`Already on ${targetChain.name}`, 'info');
            return;
        }

        log(`Switching to ${targetChain.name}...`, 'info');

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: targetChain.chainId }],
            });
            log(`Switched to ${targetChain.name}`, 'success');
        } catch (switchError) {
            if (switchError.code === 4902) {
                log(`Adding ${targetChain.name} to wallet...`, 'info');
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: targetChain.chainId,
                        chainName: targetChain.name,
                        // Let wallet use its default RPC
                    }],
                });
                log(`Added ${targetChain.name}`, 'success');
            } else {
                throw switchError;
            }
        }

        await updateWalletInfo();
    } catch (error) {
        const err = parseError(error);
        log(`Failed to switch chain: ${err.message}`, 'error');
        showStatus(err.title, err.message, err.type);
        throw error;
    }
}

// Transaction Preview
function renderTransactionPreview(request) {
    const details = document.getElementById('txDetails');
    const data = request.data;

    let html = '';

    if (request.type === 'send_transaction') {
        html += `<div class="tx-param">
            <span class="tx-param-name">To:</span>
            <span class="tx-param-value">${data.to}</span>
        </div>`;

        if (data.value && data.value !== '0x0') {
            const ethValue = parseInt(data.value, 16) / 1e18;
            html += `<div class="tx-param">
                <span class="tx-param-name">Value:</span>
                <span class="tx-param-value">${ethValue.toFixed(6)} ETH</span>
            </div>`;
        }

        if (data.data && data.data !== '0x') {
            html += `<div class="tx-param">
                <span class="tx-param-name">Data:</span>
                <span class="tx-param-value">${data.data.substring(0, 66)}${data.data.length > 66 ? '...' : ''}</span>
            </div>`;
        }
    } else if (request.type === 'sign_message') {
        html += `<div class="tx-param">
            <span class="tx-param-name">Message:</span>
            <span class="tx-param-value">${data.message}</span>
        </div>`;
    }

    details.innerHTML = html;
}

// WebSocket Connection
function connectWebSocket() {
    // Close existing connection if any
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.close();
    }

    state.ws = new WebSocket('ws://localhost:3456');

    state.ws.onopen = () => {
        log('WebSocket connected', 'success');
        showStatus('Ready', 'Ready to sign transactions', 'success');
    };

    state.ws.onmessage = async (event) => {
        try {
            state.currentRequest = JSON.parse(event.data);
            log(`Received ${state.currentRequest.type} request on ${state.currentRequest.chain}`, 'info');

            // Switch chain if needed
            if (state.currentRequest.chain && state.currentRequest.chain !== 'any') {
                await switchToChain(state.currentRequest.chain);
            }

            // Show transaction preview
            renderTransactionPreview(state.currentRequest);
            document.getElementById('txPreview').classList.remove('hidden');
            showStatus('Pending', 'Transaction waiting for approval', 'warning');

        } catch (error) {
            const err = parseError(error);
            log(`Error handling message: ${err.message}`, 'error');
            showStatus(err.title, err.message, err.type);
        }
    };

    state.ws.onerror = (error) => {
        log('WebSocket error', 'error');
        console.error(error);
    };

    state.ws.onclose = () => {
        log('WebSocket disconnected', 'error');
        showStatus('Disconnected', 'Connection to server lost. Reconnecting...', 'error');
        setTimeout(connectWebSocket, 3000);
    };
}

// Transaction Actions
async function approveTx() {
    if (!state.currentRequest) return;

    // Prevent double submission - clear current request immediately
    const request = state.currentRequest;
    state.currentRequest = null;

    try {
        // Ensure we have account
        if (!state.account) {
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            state.account = accounts[0];
        }

        if (!state.account) {
            throw new Error('No account available. Please connect your wallet first.');
        }

        log('Sending transaction...', 'info');
        let result;

        if (request.type === 'send_transaction') {
            const txData = {
                ...request.data,
                from: state.account
            };

            result = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [txData]
            });
        } else if (request.type === 'sign_message') {
            result = await window.ethereum.request({
                method: 'personal_sign',
                params: [request.data.message, state.account]
            });
        } else if (request.type === 'sign_typed_data') {
            result = await window.ethereum.request({
                method: 'eth_signTypedData_v4',
                params: [state.account, JSON.stringify(request.data)]
            });
        }

        log(`Transaction successful: ${result}`, 'success');
        showStatus('Success', 'Transaction submitted successfully', 'success');

        // Add to history
        txHistory.add({
            hash: result,
            chain: request.chain,
            function: request.data.data ? 'Contract Call' : 'Transfer',
            contract: request.data.to,
            status: 'success'
        });

        state.ws.send(JSON.stringify({
            id: request.id,
            success: true,
            result
        }));

        document.getElementById('txPreview').classList.add('hidden');

    } catch (error) {
        const err = parseError(error);
        log(`Transaction failed: ${err.message}`, 'error');
        showStatus(err.title, err.message, err.type);

        // Add to history as failed (unless it was a user rejection)
        if (!error.message.includes('User rejected') && !error.message.includes('User denied')) {
            txHistory.add({
                chain: request.chain,
                function: request.data.data ? 'Contract Call' : 'Transfer',
                contract: request.data.to,
                status: 'failed'
            });
        }

        state.ws.send(JSON.stringify({
            id: request.id,
            success: false,
            error: error.message
        }));

        document.getElementById('txPreview').classList.add('hidden');
        state.currentRequest = null;
    }
}

function rejectTx() {
    if (!state.currentRequest) return;

    log('Transaction rejected by user', 'info');
    showStatus('Rejected', 'Transaction rejected', 'warning');

    // Don't add rejected transactions to history

    state.ws.send(JSON.stringify({
        id: state.currentRequest.id,
        success: false,
        error: 'User rejected transaction'
    }));

    document.getElementById('txPreview').classList.add('hidden');
    state.currentRequest = null;
}

// Auto-connect on load
window.addEventListener('load', async () => {
    // Determine which provider to use
    let availableProvider = null;
    if (window.rabby) {
        availableProvider = window.rabby;
    } else if (window.ethereum) {
        availableProvider = window.ethereum;
    }

    if (availableProvider) {
        try {
            const wasConnected = localStorage.getItem('walletConnected') === 'true';

            if (wasConnected) {
                log('Reconnecting to saved wallet...', 'info');
            }

            const accounts = await availableProvider.request({
                method: 'eth_accounts'
            });

            if (accounts.length > 0 || wasConnected) {
                connectWallet();
            }
        } catch (error) {
            log('Auto-connect failed', 'error');
            console.error(error);
        }
    }

    // Load transaction history
    txHistory.render();
});
