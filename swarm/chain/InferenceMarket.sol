// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GaslessERC20} from "./GaslessERC20.sol";

/// Paying the swarm for an answer, in PIPER.
///
/// An asker commits the most it will pay for one question: it signs a PIPER
/// ReceiveWithAuthorization to this contract for maxPayment, with the
/// query's id as the nonce. The id is a hash of the asker, the prompt's hash
/// and a salt, so that one signature fixes who asks, what, and for how much,
/// and nobody else can open a query with it. Anyone may submit it (the
/// tracker's gas sponsor does, so the asker needs no ETH); open() escrows the
/// tokens.
///
/// maxPayment / pricePerToken is the query's token limit. The tracker stops
/// the answer at the model's stop token or at the limit, whichever comes
/// first, and settles with the number of tokens the swarm ran (prompt and
/// answer): that many times the price goes to the treasury, which pays the
/// phones, and the rest goes back to the asker. A query the operator never
/// settles can be reclaimed in full by its asker after a day.
contract InferenceMarket is Ownable {
    struct Query {
        address asker;
        uint64 openedAt;
        bool closed;
        uint256 maxPayment;
        uint256 pricePerToken; // the price when it opened
    }

    GaslessERC20 public immutable token;
    address public treasury;
    address public operator;
    uint256 public pricePerToken;
    uint256 public constant RECLAIM_AFTER = 1 days;

    mapping(bytes32 id => Query) public queries;

    event QueryOpened(bytes32 indexed id, address indexed asker, uint256 maxPayment, uint256 maxTokens, bytes32 promptHash);
    event QuerySettled(bytes32 indexed id, uint256 tokens, uint256 cost, uint256 refund);
    event QueryReclaimed(bytes32 indexed id, uint256 refund);
    event PriceSet(uint256 pricePerToken);
    event OperatorSet(address operator);
    event TreasurySet(address treasury);

    error QueryExists();
    error UnknownQuery();
    error QueryClosed();
    error NotOperator();
    error NotAsker();
    error TooEarly();
    error BelowOneToken();
    error ZeroPrice();

    constructor(GaslessERC20 token_, address treasury_, address operator_, uint256 pricePerToken_) Ownable(msg.sender) {
        if (pricePerToken_ == 0) revert ZeroPrice();
        token = token_;
        treasury = treasury_;
        operator = operator_;
        pricePerToken = pricePerToken_;
    }

    function queryId(address asker, bytes32 promptHash, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(asker, promptHash, salt));
    }

    function open(
        address asker,
        uint256 maxPayment,
        uint256 validBefore,
        bytes32 promptHash,
        bytes32 salt,
        bytes calldata signature
    ) external returns (bytes32 id) {
        id = queryId(asker, promptHash, salt);
        if (queries[id].asker != address(0)) revert QueryExists();
        if (maxPayment < pricePerToken) revert BelowOneToken();
        token.receiveWithAuthorization(asker, address(this), maxPayment, 0, validBefore, id, signature);
        queries[id] = Query(asker, uint64(block.timestamp), false, maxPayment, pricePerToken);
        emit QueryOpened(id, asker, maxPayment, maxPayment / pricePerToken, promptHash);
    }

    function maxTokens(bytes32 id) external view returns (uint256) {
        Query storage q = queries[id];
        return q.pricePerToken == 0 ? 0 : q.maxPayment / q.pricePerToken;
    }

    /// tokens: how many the swarm ran for this query. The cost never goes
    /// over what the asker committed.
    function settle(bytes32 id, uint256 tokens) external {
        if (msg.sender != operator) revert NotOperator();
        Query storage q = _openQuery(id);
        q.closed = true;
        uint256 cost = tokens * q.pricePerToken;
        if (cost > q.maxPayment) cost = q.maxPayment;
        uint256 refund = q.maxPayment - cost;
        if (cost > 0) token.transfer(treasury, cost);
        if (refund > 0) token.transfer(q.asker, refund);
        emit QuerySettled(id, tokens, cost, refund);
    }

    function reclaim(bytes32 id) external {
        Query storage q = _openQuery(id);
        if (msg.sender != q.asker) revert NotAsker();
        if (block.timestamp < q.openedAt + RECLAIM_AFTER) revert TooEarly();
        q.closed = true;
        token.transfer(q.asker, q.maxPayment);
        emit QueryReclaimed(id, q.maxPayment);
    }

    function setPrice(uint256 pricePerToken_) external onlyOwner {
        if (pricePerToken_ == 0) revert ZeroPrice();
        pricePerToken = pricePerToken_;
        emit PriceSet(pricePerToken_);
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _openQuery(bytes32 id) private view returns (Query storage q) {
        q = queries[id];
        if (q.asker == address(0)) revert UnknownQuery();
        if (q.closed) revert QueryClosed();
    }
}
