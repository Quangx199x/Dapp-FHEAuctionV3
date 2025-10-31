import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import './index.css';

// Contract configuration
const CONTRACT_ADDRESS = "0xf885102a2ac3ef23744defb89ce71ad2b458e0ab";
const SEPOLIA_CHAIN_ID = 11155111;

// Simplified ABI - only functions we need
const CONTRACT_ABI = [
  // View functions
  "function getAuctionInfo() view returns (uint256 round, uint256 endBlock, uint8 state, uint256 maxDeposit, address leadBidder, uint256 validBidders)",
  "function getEstimatedEndTime() view returns (uint256)",
  "function getBidderInfo(address) view returns (uint256 deposit, bool hasBidded, bool cancelled)",
  "function getRoundBidders() view returns (address[])",
  "function minBidDeposit() view returns (uint256)",
  "function pendingRefunds(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function beneficiary() view returns (address)",
  "function feeCollector() view returns (address)",
  "function totalCollectedFees() view returns (uint256)",
  
  // State-changing functions
  "function bid(bytes32 encryptedBid, bytes inputProof, bytes32 publicKey, bytes signature) payable",
  "function cancelBid()",
  "function claimRefund()",
  "function requestFinalize()",
  "function pauseAuction()",
  "function unpauseAuction()",
  "function updateBeneficiary(address)",
  "function updateFeeCollector(address)",
  "function transferOwnership(address)",
  "function withdrawPlatformFees()",
  
  // Events
  "event BidPlaced(address indexed bidder, uint256 indexed round, uint256 depositAmount, uint256 blockNumber, uint256 timestamp)",
  "event BidCancelled(address indexed bidder, uint256 indexed round, uint256 refundAmount, uint256 timestamp)",
  "event AuctionFinished(uint256 indexed round, address indexed winner, uint256 finalBid, uint256 platformFee, uint256 timestamp)",
  "event RefundClaimed(address indexed recipient, uint256 amount)",
  
  // Custom Errors
  "error AuctionPaused()",
  "error AuctionNotActive()",
  "error AlreadyBidded()",
  "error BidNotFound()",
  "error DepositTooLow(uint256 required, uint256 provided)",
  "error InvalidBidAmount()",
  "error InvalidProof()",
  "error InvalidSignature()",
  "error InvalidPublicKey()",
  "error NoRefundAvailable()",
  "error NotOwner()",
  "error FinalizationNotReady()",
  "error AlreadyFinalized()",
  "error InsufficientDeposit(uint256 required, uint256 provided)",
  "error MaxBiddersReached(uint256 max)",
  "error ContractPaused()",
  "error BidTooLow(uint256 required, uint256 current)",
  "error InvalidAmount()",
  "error TransferFailed()",
  "error DecryptionInProgress()",
  "error DecryptionFailed()",
  "error InvalidCallback()",
  "error UnauthorizedCallback()",
  "error InvalidState(uint8 current, uint8 expected)",
  "error ZeroAddress()",
  "error InvalidBeneficiary()"
];

function App() {
  // State management
  const [activeTab, setActiveTab] = useState<'user' | 'owner'>('user');
  const [account, setAccount] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [fheInstance, setFheInstance] = useState<any>(null);
  const [fhePublicKey, setFhePublicKey] = useState<string>('');
  const [fheStatus, setFheStatus] = useState('Not initialized');
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [logs, setLogs] = useState<any[]>([]);

  // Auction data state
  const [auctionData, setAuctionData] = useState({
    round: 0,
    state: 'LOADING',
    validBidders: 0,
    currentLeader: 'None',
    endBlock: 0,
    currentBlock: 0,
    timeRemaining: '00:00:00',
    progress: 0,
    minIncrement: '0.00000001',
    estimatedEndTime: '',
    maxDepositWei: BigInt(0),
  });

  // User data state
  const [bidderInfo, setBidderInfo] = useState({
    deposit: '0',
    hasBidded: false,
    cancelled: false,
  });

  const [pendingRefund, setPendingRefund] = useState('0');
  const [roundBidders, setRoundBidders] = useState<string[]>([]);

  // Owner data state
  const [contractOwner, setContractOwner] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [beneficiaryAddr, setBeneficiaryAddr] = useState('');
  const [feeCollectorAddr, setFeeCollectorAddr] = useState('');
  const [totalFees, setTotalFees] = useState('0');
  const [decryptionStatus, setDecryptionStatus] = useState<'IDLE' | 'PROCESSING' | 'COMPLETED'>('IDLE');

  // Form inputs
  const [bidAmount, setBidAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [newBeneficiary, setNewBeneficiary] = useState('');
  const [newFeeCollector, setNewFeeCollector] = useState('');
  const [newOwner, setNewOwner] = useState('');

  // Loading states
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const isOwner = account && contractOwner && account.toLowerCase() === contractOwner.toLowerCase();

  const addLog = (type: string, msg: string, txHash?: string) => {
    setLogs(prev => [{
      time: new Date().toLocaleTimeString(),
      type,
      msg,
      txHash
    }, ...prev].slice(0, 50));
  };

  // Connect wallet
  const connectWallet = async () => {
    if (!window.ethereum) {
      addLog('error', 'Please install MetaMask');
      return;
    }

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const network = await provider.getNetwork();

      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        addLog('error', 'Please switch to Sepolia network');
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}` }],
          });
        } catch (switchError: any) {
          addLog('error', switchError.message || 'Failed to switch network');
          return;
        }
      }

      setAccount(accounts[0]);
      setIsConnected(true);
      
      const signer = await provider.getSigner();
      const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(contractInstance);
      
      addLog('success', `Connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
    } catch (error: any) {
      addLog('error', error.message);
    }
  };

  // Initialize FHE SDK
  const initFHE = async () => {
    if (fheStatus === 'Ready' || fheStatus === 'Initializing...') return;
    try {
      setFheStatus('Initializing...');
      addLog('pending', 'Loading FHE SDK v0.2.0 from Zama CDN...');
      
      const FheSDKModule = await Promise.race([
        import('https://cdn.zama.ai/relayer-sdk-js/0.2.0/relayer-sdk-js.js'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SDK load timeout')), 30000)
        )
      ]);

      const { initSDK, createInstance, SepoliaConfig } = FheSDKModule;
      
      addLog('pending', 'Initializing WASM files...');
      await Promise.race([
        initSDK(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SDK init timeout')), 30000)
        )
      ]);

      addLog('pending', 'Creating FHE instance...');
      const config = { 
        ...SepoliaConfig, 
        network: window.ethereum,
        contractAddress: CONTRACT_ADDRESS,
        gatewayUrl: 'https://gateway.sepolia.zama.ai/',
      };
      
      const instance = await Promise.race([
        createInstance(config),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Instance creation timeout')), 30000)
        )
      ]);
      
      addLog('info', 'Extracting FHE public key...');
      const publicKey = instance.getPublicKey();
      let fullPublicKeyHex: string;
      
      if (typeof publicKey === 'string') {
        fullPublicKeyHex = publicKey.startsWith('0x') ? publicKey : '0x' + publicKey;
      } else if (publicKey instanceof Uint8Array) {
        fullPublicKeyHex = ethers.hexlify(publicKey);
      } else if (typeof publicKey === 'object' && publicKey.publicKey instanceof Uint8Array) {
        fullPublicKeyHex = ethers.hexlify(publicKey.publicKey);
      } else if (typeof publicKey === 'object' && publicKey.key) {
        const keyValue = publicKey.key;
        fullPublicKeyHex = (typeof keyValue === 'string' && keyValue.startsWith('0x')) ? keyValue : ethers.hexlify(keyValue);
      } else {
        throw new Error(`Invalid public key format: ${typeof publicKey}`);
      }
      
      const pkLength = (fullPublicKeyHex.length - 2) / 2;
      let publicKeyBytes32: string;
      
      if (pkLength <= 32) {
        publicKeyBytes32 = ethers.zeroPadValue(fullPublicKeyHex, 32);
      } else {
        publicKeyBytes32 = ethers.keccak256(fullPublicKeyHex);
      }
      
      setFheInstance(instance);
      setFhePublicKey(publicKeyBytes32);
      setFheStatus('Ready');
      addLog('success', `FHE SDK initialized successfully`);
      addLog('info', `Public Key Hash (bytes32): ${publicKeyBytes32.slice(0, 20)}...${publicKeyBytes32.slice(-10)}`);
      
    } catch (error: any) {
      setFheStatus('Failed');
      addLog('error', `FHE initialization failed: ${error.message}`);
      console.error('Full error:', error);
    }
  };

  // Fetch auction info
  const fetchAuctionInfo = useCallback(async () => {
    if (!contract) return;

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const [info, currentBlock, estimatedEnd, minDeposit] = await Promise.all([
        contract.getAuctionInfo(),
        provider.getBlockNumber(),
        contract.getEstimatedEndTime().catch(() => 0),
        contract.minBidDeposit().catch(() => BigInt(10000000))
      ]);
      
      const maxDepositWei = info.maxDeposit;
      const blocksRemaining = Math.max(0, Number(info.endBlock) - currentBlock);
      const secondsRemaining = blocksRemaining * 12;
      const hours = Math.floor(secondsRemaining / 3600);
      const minutes = Math.floor((secondsRemaining % 3600) / 60);
      const seconds = secondsRemaining % 60;
      
      let estimatedEndTimeStr = '';
      if (estimatedEnd > 0) {
        const endDate = new Date(Number(estimatedEnd) * 1000);
        estimatedEndTimeStr = endDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      }
      
      const stateNames = ['ACTIVE', 'ENDED', 'FINALIZING', 'FINALIZED', 'EMERGENCY'];
      const totalBlocks = 7200;
      const progressPercent = Math.min(100, ((totalBlocks - blocksRemaining) / totalBlocks) * 100);
      
      setAuctionData({
        round: Number(info.round),
        state: stateNames[Number(info.state)] || 'UNKNOWN',
        validBidders: Number(info.validBidders),
        currentLeader: info.leadBidder === ethers.ZeroAddress ? 'None' : info.leadBidder,
        endBlock: Number(info.endBlock),
        currentBlock: currentBlock,
        timeRemaining: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        progress: progressPercent,
        minIncrement: ethers.formatEther(minDeposit) + ' ETH',
        estimatedEndTime: estimatedEndTimeStr,
        maxDepositWei: maxDepositWei,
      });

      const stateNum = Number(info.state);
      if (stateNum === 2) setDecryptionStatus('PROCESSING');
      else if (stateNum === 3) setDecryptionStatus('COMPLETED');
      else setDecryptionStatus('IDLE');

      if (account) {
        const bInfo = await contract.getBidderInfo(account);
        setBidderInfo({
          deposit: ethers.formatEther(bInfo.deposit),
          hasBidded: bInfo.hasBidded,
          cancelled: bInfo.cancelled,
        });
        const refund = await contract.pendingRefunds(account);
        setPendingRefund(ethers.formatEther(refund));
      }

      const bidders = await contract.getRoundBidders();
      setRoundBidders(bidders);

    } catch (error: any) {
      console.error('Error fetching auction info:', error);
      addLog('error', 'Failed to fetch auction data');
    }
  }, [contract, account]);

  // Fetch owner info
  const fetchOwnerInfo = useCallback(async () => {
    if (!contract) return;
    try {
      const [owner, paused, beneficiary, feeCollector, fees] = await Promise.all([
        contract.owner(),
        contract.paused(),
        contract.beneficiary(),
        contract.feeCollector(),
        contract.totalCollectedFees()
      ]);
      setContractOwner(owner);
      setIsPaused(paused);
      setBeneficiaryAddr(beneficiary);
      setFeeCollectorAddr(feeCollector);
      setTotalFees(ethers.formatEther(fees));
    } catch (error: any) {
      console.error('Error fetching owner info:', error);
    }
  }, [contract]);

  // Submit encrypted bid - FIXED VERSION
 const handleSubmitBid = async () => {
  if (!contract || !fheInstance || !account || !bidAmount || !depositAmount || !fhePublicKey) {
    addLog('error', '❌ Missing requirements');
    return;
  }

  try {
    setIsSubmitting(true);
    addLog('info', '🧪 Testing APPROACH 5: publicKey = hash(encBid + fhePK), sign same');
    
    // Validation code...
    const bidValue = parseFloat(bidAmount);
    const depositWei = ethers.parseEther(depositAmount);
    
    // Encrypt bid
    const bidInGwei = Math.floor(bidValue * 1e9);
    const input = fheInstance.createEncryptedInput(CONTRACT_ADDRESS, account);
    input.add64(BigInt(bidInGwei));
    const encryptedData = await input.encrypt();
    
    const encryptedBidHandle = encryptedData.handles[0];
    const inputProofHex = ethers.hexlify(encryptedData.inputProof);
    
    // Create a hash of combined data
    const combinedData = ethers.concat([encryptedBidHandle, fhePublicKey]);
    const hashedKey = ethers.keccak256(combinedData);
    
    // Sign the hash
    const domain = {
      name: 'FHEAuction',
      version: '3',
      chainId: SEPOLIA_CHAIN_ID,
      verifyingContract: CONTRACT_ADDRESS,
    };
    const types = { PublicKey: [{ name: 'key', type: 'bytes32' }] };
    const value = { key: hashedKey };
    
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const signature = await signer.signTypedData(domain, types, value);
    
    addLog('info', `Using hashed combined key: ${hashedKey.slice(0, 20)}...`);
    
    const tx = await contract.bid(
      encryptedBidHandle,
      inputProofHex,
      hashedKey,
      signature,
      { value: depositWei, gasLimit: BigInt(10000000) }
    );
    
    addLog('pending', `TX: ${tx.hash}`);
    const receipt = await tx.wait();
    addLog('success', `✅ Success with Approach 5!`, tx.hash);
    
  } catch (error: any) {
    addLog('error', `❌ Approach 5 failed: ${error.message}`);
  } finally {
    setIsSubmitting(false);
  }
};


  // Cancel bid
  const handleCancelBid = async () => {
    if (!contract || !account) {
      addLog('error', 'Not connected');
      return;
    }

    try {
      setIsSubmitting(true);
      addLog('pending', 'Cancelling bid...');
      
      const tx = await contract.cancelBid();
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Bid cancelled successfully!`, tx.hash);
      
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.message || 'Failed to cancel bid');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Claim refund
  const handleClaimRefund = async () => {
    if (!contract || !account) {
      addLog('error', 'Not connected');
      return;
    }

    try {
      setIsSubmitting(true);
      addLog('pending', 'Claiming refund...');
      
      const tx = await contract.claimRefund();
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Refund claimed successfully!`, tx.hash);
      
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.message || 'Failed to claim refund');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Owner functions
  const handleRequestFinalize = async () => {
    if (!contract || !isOwner) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Requesting auction finalization...');
      
      const tx = await contract.requestFinalize({ gasLimit: BigInt(5000000) });
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Finalization requested successfully!`, tx.hash);
      
      setDecryptionStatus('PROCESSING');
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.message || 'Failed to request finalization');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePauseAuction = async () => {
    if (!contract || !isOwner) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Pausing auction...');
      
      const tx = await contract.pauseAuction();
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Auction paused successfully!`, tx.hash);
      
      setIsPaused(true);
    } catch (error: any) {
      addLog('error', error.message || 'Failed to pause auction');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnpauseAuction = async () => {
    if (!contract || !isOwner) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Unpausing auction...');
      
      const tx = await contract.unpauseAuction();
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Auction unpaused successfully!`, tx.hash);
      
      setIsPaused(false);
    } catch (error: any) {
      addLog('error', error.message || 'Failed to unpause auction');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateBeneficiary = async () => {
    if (!contract || !isOwner || !newBeneficiary) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Updating beneficiary...');
      
      const tx = await contract.updateBeneficiary(newBeneficiary);
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Beneficiary updated successfully!`, tx.hash);
      
      setBeneficiaryAddr(newBeneficiary);
      setNewBeneficiary('');
    } catch (error: any) {
      addLog('error', error.message || 'Failed to update beneficiary');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateFeeCollector = async () => {
    if (!contract || !isOwner || !newFeeCollector) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Updating fee collector...');
      
      const tx = await contract.updateFeeCollector(newFeeCollector);
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Fee collector updated successfully!`, tx.hash);
      
      setFeeCollectorAddr(newFeeCollector);
      setNewFeeCollector('');
    } catch (error: any) {
      addLog('error', error.message || 'Failed to update fee collector');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdrawFees = async () => {
    if (!contract || !isOwner) return;
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Withdrawing platform fees...');
      
      const tx = await contract.withdrawPlatformFees();
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Platform fees withdrawn successfully!`, tx.hash);
      
      setTotalFees('0');
    } catch (error: any) {
      addLog('error', error.message || 'Failed to withdraw fees');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTransferOwnership = async () => {
    if (!contract || !isOwner || !newOwner) return;
    
    if (!window.confirm('Are you sure you want to transfer ownership? This action is irreversible!')) {
      return;
    }
    
    try {
      setIsSubmitting(true);
      addLog('pending', 'Transferring ownership...');
      
      const tx = await contract.transferOwnership(newOwner);
      addLog('pending', `Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait();
      addLog('success', `Ownership transferred successfully!`, tx.hash);
      
      setContractOwner(newOwner);
      setNewOwner('');
    } catch (error: any) {
      addLog('error', error.message || 'Failed to transfer ownership');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Effects
  useEffect(() => {
    if (isConnected) {
      fetchAuctionInfo();
      fetchOwnerInfo();
      const interval = setInterval(() => {
        fetchAuctionInfo();
        if (activeTab === 'owner') {
          fetchOwnerInfo();
        }
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [isConnected, activeTab, fetchAuctionInfo, fetchOwnerInfo]);

  // Computed values
  const isFinalizationReady = auctionData.state === 'ENDED' && auctionData.validBidders > 0;

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-title">
          <span className="title-main">FHE AUCTION</span>
          <span className="title-sub">[SYSTEM ONLINE] FHE AUCTION by ZAMA</span>
        </div>
        <div className="header-info">
          <div>CONTRACT: {CONTRACT_ADDRESS.slice(0, 6)}...{CONTRACT_ADDRESS.slice(-4)}</div>
          <div>NETWORK: SEPOLIA</div>
          <div>ROUND: #{auctionData.round}</div>
        </div>
        {!isConnected ? (
          <button className="btn-connect" onClick={connectWallet}>
            CONNECT WALLET
          </button>
        ) : (
          <div className="account">
            <span className="badge">CONNECTED</span>
            <span>{account.slice(0, 6)}...{account.slice(-4)}</span>
          </div>
        )}
      </div>

      {/* Auction Status Panel */}
      <div className="panel glow">
        <div className="panel-header">&gt; AUCTION STATUS</div>
        <div className="auction-stats">
          <div className="stat">
            <div className="stat-label">STATE</div>
            <div className={`stat-value ${auctionData.state === 'ACTIVE' ? 'active' : auctionData.state === 'ENDED' ? 'ended' : ''}`}>
              {auctionData.state}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">BIDDERS</div>
            <div className="stat-value">{auctionData.validBidders}/50</div>
          </div>
          <div className="stat">
            <div className="stat-label">TIME LEFT</div>
            <div className="stat-value countdown">{auctionData.timeRemaining}</div>
          </div>
          <div className="stat">
            <div className="stat-label">END BLOCK</div>
            <div className="stat-value">#{auctionData.endBlock}</div>
          </div>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${auctionData.progress}%` }}></div>
        </div>
        <div className="info-item">
          <div className="info-label">[MINIMUM DEPOSIT INCREMENT]</div>
          <div className="info-value">{auctionData.minIncrement}</div>
        </div>
        <div className="info-item">
          <div className="info-label">[ESTIMATED END TIME]</div>
          <div className="info-value" style={{ fontSize: '0.9rem' }}>
            {auctionData.estimatedEndTime || 'Calculating...'}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">[CURRENT LEADER]</div>
          <div className="info-value encrypted">{auctionData.currentLeader === 'None' ? 'NONE' : `${auctionData.currentLeader.slice(0, 6)}...${auctionData.currentLeader.slice(-4)}`}</div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="tab-nav">
        <button 
          className={`tab ${activeTab === 'user' ? 'active' : ''}`} 
          onClick={() => setActiveTab('user')}
        >
          USER PANEL
        </button>
        <button 
          className={`tab ${activeTab === 'owner' ? 'active' : ''} ${isOwner ? 'owner-tab' : ''}`} 
          onClick={() => setActiveTab('owner')}
          disabled={!isOwner}
        >
          OWNER PANEL {isOwner && <span className="badge">ADMIN</span>}
        </button>
      </div>

      {/* User Panel */}
      {activeTab === 'user' ? (
        <div>
          {/* FHE Status Panel */}
          <div className="panel">
            <div className="panel-header">&gt; FHE ENCRYPTION STATUS</div>
            <div className="info-item">
              <div className="info-label">[FHE SDK STATUS]</div>
              <div className={`badge ${fheStatus === 'Ready' ? '' : 'badge-encrypted'}`}>
                {fheStatus}
              </div>
            </div>
            <div className="info-item">
              <div className="info-label">[FHE PUBLIC KEY]</div>
              <div style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
                {fhePublicKey ? `${fhePublicKey.slice(0, 20)}...${fhePublicKey.slice(-10)}` : 'Not initialized'}
              </div>
            </div>
            <button 
              className="btn" 
              onClick={initFHE} 
              disabled={fheStatus === 'Ready' || fheStatus === 'Initializing...'}
              style={{ width: '100%' }}
            >
              {fheStatus === 'Ready' ? '✓ FHE READY' : fheStatus === 'Initializing...' ? 'INITIALIZING...' : 'INITIALIZE FHE SDK'}
            </button>
          </div>

          {/* Place Bid Panel */}
          <div className="panel glow">
            <div className="panel-header">&gt; PLACE ENCRYPTED BID</div>
            <div className="info-item">
              <div className="info-label">[YOUR STATUS]</div>
              {bidderInfo.hasBidded ? (
                <span className="badge">BID PLACED</span>
              ) : bidderInfo.cancelled ? (
                <span className="badge badge-encrypted">CANCELLED</span>
              ) : (
                <span className="badge badge-encrypted">NO BID</span>
              )}
            </div>
            {bidderInfo.hasBidded && (
              <div className="info-item">
                <div className="info-label">[YOUR DEPOSIT]</div>
                <div className="info-value">{bidderInfo.deposit} ETH</div>
              </div>
            )}
            {!bidderInfo.hasBidded && !bidderInfo.cancelled && (
              <>
                <input
                  type="number"
                  className="input"
                  placeholder="Bid Amount (ETH)"
                  value={bidAmount}
                  onChange={(e) => setBidAmount(e.target.value)}
                  disabled={auctionData.state !== 'ACTIVE'}
                  step="0.0001"
                />
                <input
                  type="number"
                  className="input"
                  placeholder="Deposit Amount (ETH)"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  disabled={auctionData.state !== 'ACTIVE'}
                  step="0.0001"
                />
                <button
                  className="btn btn-primary"
                  onClick={handleSubmitBid}
                  disabled={
                    !isConnected || 
                    auctionData.state !== 'ACTIVE' || 
                    fheStatus !== 'Ready' || 
                    isSubmitting ||
                    !bidAmount ||
                    !depositAmount
                  }
                >
                  {isSubmitting ? 'ENCRYPTING & SUBMITTING...' : 'SUBMIT ENCRYPTED BID'}
                </button>
              </>
            )}
            {bidderInfo.hasBidded && auctionData.state === 'ACTIVE' && (
              <button className="btn btn-red" onClick={handleCancelBid} disabled={isSubmitting}>
                CANCEL BID
              </button>
            )}
            <div style={{ marginTop: '0.5rem', padding: '0.5rem', border: '1px solid var(--green-dark)', fontSize: '0.75rem' }}>
              [INFO] Deposit must exceed current max: {ethers.formatEther(auctionData.maxDepositWei)} ETH
            </div>
          </div>

          {/* Refunds Panel */}
          {parseFloat(pendingRefund) > 0 && (
            <div className="panel">
              <div className="panel-header">&gt; PENDING REFUNDS</div>
              <div className="info-item">
                <div className="info-label">[REFUND AVAILABLE]</div>
                <div className="info-value">{pendingRefund} ETH</div>
              </div>
              <button className="btn" onClick={handleClaimRefund} disabled={isSubmitting}>
                CLAIM REFUND
              </button>
            </div>
          )}

          {/* Current Round Bidders */}
          <div className="panel">
            <div className="panel-header">&gt; CURRENT ROUND BIDDERS [{roundBidders.length}/50]</div>
            {roundBidders.length === 0 ? (
              <div className="empty">[NO BIDDERS YET]</div>
            ) : (
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {roundBidders.map((bidder, i) => (
                  <div key={i} style={{ padding: '0.5rem', borderBottom: '1px solid var(--green-dark)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>[{i + 1}] {bidder.slice(0, 6)}...{bidder.slice(-4)}</span>
                    {bidder.toLowerCase() === account.toLowerCase() && (
                      <span className="badge">YOU</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        isOwner && <div>
          <div className="panel glow" style={{ borderColor: isOwner ? 'var(--pink)' : 'var(--red)' }}>
            <div className="panel-header">&gt; &gt; AUCTION CONTROL PANEL</div>
            <div className="info-item">
              <div className="info-label">[OWNER ADDRESS]</div>
              <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                {contractOwner ? (isConnected ? 
                  `${contractOwner.slice(0, 6)}...${contractOwner.slice(-4)}` : 
                  'Not Connected') : 'Loading...'}
              </div>
              {isOwner && (
                <div className="badge" style={{ marginTop: '0.5rem', background: 'var(--pink)' }}>
                  ✓ YOU ARE OWNER
                </div>
              )}
            </div>
            <div className="info-item">
              <div className="info-label">[DECRYPTION STATUS]</div>
              <div className={'badge'} style={{
                background: decryptionStatus === 'IDLE' ? 'transparent' :
                           decryptionStatus === 'PROCESSING' ? 'var(--pink)' :
                           'var(--green)'
              }}>
                {decryptionStatus}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
              <button 
                className="btn" 
                onClick={handleRequestFinalize}
                disabled={!isFinalizationReady || decryptionStatus === 'PROCESSING'}
                style={{ 
                  borderColor: isFinalizationReady ? 'var(--green)' : 'var(--green-dark)',
                  color: isFinalizationReady ? 'var(--green)' : 'var(--green-dark)'
                }}
              >
                REQUEST FINALIZE
              </button>
              <button className="btn btn-red" disabled={true} style={{ opacity: 0.5 }}>
                FORCE FINALIZE
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button className="btn btn-red" disabled={true} style={{ opacity: 0.5 }}>
                CANCEL DECRYPTION
              </button>
              <button className="btn btn-red" disabled={true} style={{ opacity: 0.5 }}>
                EMERGENCY END
              </button>
            </div>
            <div style={{ marginTop: '0.5rem', padding: '0.5rem', border: '1px solid var(--pink)', color: 'var(--pink)', fontSize: '0.75rem' }}>
              [NOTE] Advanced controls are disabled in this version. Only REQUEST FINALIZE is available when auction ENDED.
            </div>
          </div>
          <div className="panel glow">
            <div className="panel-header">&gt; AUCTION STATUS CONTROL</div>
            <div className="info-item">
              <div className="info-label">[AUCTION STATUS]</div>
              <div className={isPaused ? 'badge-encrypted badge' : 'badge'}>
                {isPaused ? '⏸ PAUSED' : '▶ RUNNING'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button className="btn" onClick={handlePauseAuction} disabled={!isOwner || isPaused}>
                PAUSE AUCTION
              </button>
              <button className="btn" onClick={handleUnpauseAuction} disabled={!isOwner || !isPaused}>
                UNPAUSE AUCTION
              </button>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">&gt; CONFIGURATION MANAGEMENT</div>
            <div className="info-item">
              <div className="info-label">[CURRENT BENEFICIARY]</div>
              <div style={{ fontSize: '0.8rem' }}>
                {beneficiaryAddr ? `${beneficiaryAddr.slice(0, 10)}...${beneficiaryAddr.slice(-8)}` : 'Loading...'}
              </div>
            </div>
            <input className="input" placeholder="New Beneficiary Address (0x...)" value={newBeneficiary} onChange={(e) => setNewBeneficiary(e.target.value)} disabled={!isOwner} />
            <div className="info-item">
              <div className="info-label">[CURRENT FEE COLLECTOR]</div>
              <div style={{ fontSize: '0.8rem' }}>
                {feeCollectorAddr ? `${feeCollectorAddr.slice(0, 10)}...${feeCollectorAddr.slice(-8)}` : 'Loading...'}
              </div>
            </div>
            <input className="input" placeholder="New Fee Collector Address (0x...)" value={newFeeCollector} onChange={(e) => setNewFeeCollector(e.target.value)} disabled={!isOwner} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button className="btn" onClick={handleUpdateBeneficiary} disabled={!isOwner || !newBeneficiary}>
                UPDATE BENEFICIARY
              </button>
              <button className="btn" onClick={handleUpdateFeeCollector} disabled={!isOwner || !newFeeCollector}>
                UPDATE FEE COLLECTOR
              </button>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">&gt; PLATFORM FEE MANAGEMENT</div>
            <div className="info-item">
              <div className="info-label">[TOTAL COLLECTED FEES]</div>
              <div className="info-value">{parseFloat(totalFees).toFixed(4)} ETH</div>
            </div>
            <div className="info-item">
              <div className="info-label">[FEE PERCENTAGE]</div>
              <div style={{ fontSize: '1.2rem' }}>2.5% (250 basis points)</div>
            </div>
            <button className="btn" onClick={handleWithdrawFees} disabled={!isOwner || parseFloat(totalFees) === 0}>
              WITHDRAW PLATFORM FEES
            </button>
          </div>
          <div className="panel">
            <div className="panel-header">&gt; OWNERSHIP MANAGEMENT</div>
            <input className="input" placeholder="New Owner Address (0x...)" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} disabled={!isOwner} />
            <button className="btn btn-red" onClick={handleTransferOwnership} disabled={!isOwner || !newOwner}>
              TRANSFER OWNERSHIP
            </button>
            <div style={{ marginTop: '0.5rem', padding: '0.5rem', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '0.75rem' }}>
              [WARNING] This action is IRREVERSIBLE!
            </div>
          </div>
        </div>
      )}

      {/* Transaction Log */}
      <div className="panel">
        <div className="panel-header">&gt; &gt; LIVE TRANSACTION LOG</div>
        <div className="log">
          {logs.length === 0 ? (
            <div className="empty">[AWAITING TRANSACTIONS...]</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="log-item">
                <span className="log-time">[{log.time}]</span>
                <span className={`log-type ${log.type}`}>{log.type.toUpperCase()}</span>
                <span className="log-msg">{log.msg}</span>
                {log.txHash && (
                  <a 
                    href={`https://sepolia.etherscan.io/tx/${log.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--pink)', fontSize: '0.75rem' }}
                  >
                    View →
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="footer">
        <div>[SYSTEM STATUS: OPERATIONAL] • Auto-refresh: 5s</div>
        <div>
          Powered by{' '}
          <a 
            href="https://www.zama.ai/" 
            target="_blank" 
            rel="noopener noreferrer"
            style={{ 
              color: 'var(--pink)', 
              textDecoration: 'none',
              fontWeight: 'bold',
              transition: 'color 0.3s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--green)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--pink)'}
          >
            Zama FHE
          </a>
          {' '}| Network: Sepolia | Contract: {CONTRACT_ADDRESS.slice(0, 6)}...{CONTRACT_ADDRESS.slice(-4)}
        </div>
      </div>
    </div>
  );
}

export default App;