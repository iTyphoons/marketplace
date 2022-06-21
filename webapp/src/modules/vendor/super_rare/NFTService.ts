import { ethers } from 'ethers'
import { ListingStatus, Network, Order } from '@dcl/schemas'
import { Wallet } from 'decentraland-dapps/dist/modules/wallet/types'
import { ERC721__factory } from '../../../contracts'
import { getSigner } from '../../wallet/utils'
import { NFT, NFTsFetchParams, NFTsCountParams } from '../../nft/types'
import { Account } from '../../account/types'
import { getNFTId } from '../../nft/utils'
import { TokenConverter } from '../TokenConverter'
import { MarketplacePrice } from '../MarketplacePrice'
import { NFTService as NFTServiceInterface } from '../services'
import { VendorName, TransferType } from '../types'
import { ContractService } from './ContractService'
import { SuperRareAsset, SuperRareOrder, SuperRareOwner } from './types'
import { superRareAPI, MAX_QUERY_SIZE } from './api'
import { config } from '../../../config'

export class NFTService implements NFTServiceInterface<VendorName.SUPER_RARE> {
  private tokenConverter: TokenConverter
  private marketplacePrice: MarketplacePrice
  private oneEthInWei: ethers.BigNumber

  constructor() {
    this.tokenConverter = new TokenConverter()
    this.marketplacePrice = new MarketplacePrice()
    this.oneEthInWei = ethers.BigNumber.from('1000000000000000000') // 10 ** 18
  }

  async fetch(params: NFTsFetchParams) {
    let remoteNFTs: SuperRareAsset[]
    let remoteOrders: SuperRareOrder[]

    if ((params.address && !params.onlyOnSale) || !params.onlyOnSale) {
      const result = await Promise.all([
        superRareAPI.fetchNFTs(params),
        superRareAPI.fetchOrders(params)
      ])
      remoteNFTs = result[0]
      remoteOrders = result[1]
    } else {
      remoteOrders = await superRareAPI.fetchOrders(params)
      remoteNFTs = remoteOrders.map(order => order.asset)
    }

    const nfts: NFT<VendorName.SUPER_RARE>[] = []
    const accounts: Account[] = []
    const orders: Order[] = []

    const total = await this.count(params)
    const oneEthInMANA = await this.getOneEthInMANA()

    for (const asset of remoteNFTs) {
      const nft = this.toNFT(asset)

      const remoteOrder = remoteOrders.find(
        order => order.asset.id === asset.id
      )

      if (remoteOrder) {
        const order = this.toOrder(remoteOrder, oneEthInMANA)

        nft.activeOrderId = order.id

        orders.push(order)
      }

      let account = accounts.find(account => account.id === asset.owner.address)
      if (!account) {
        account = this.toAccount(asset.owner)
      }
      account.nftIds.push(nft.id)

      nfts.push(nft)
      accounts.push(account)
    }

    return [nfts, accounts, orders, total] as const
  }

  async count(countParams: NFTsCountParams) {
    const params: NFTsFetchParams = {
      ...countParams,
      first: MAX_QUERY_SIZE,
      skip: 0
    }

    let remoteElements
    if (params.address) {
      remoteElements = await superRareAPI.fetchNFTs(params)
    } else {
      remoteElements = await superRareAPI.fetchOrders(params)
    }

    return remoteElements.length
  }

  async fetchOne(contractAddress: string, tokenId: string) {
    const [remoteNFT, remoteOrder, oneEthInMANA] = await Promise.all([
      superRareAPI.fetchNFT(contractAddress, tokenId),
      superRareAPI.fetchOrder(contractAddress, tokenId),
      this.getOneEthInMANA()
    ])

    const nft = this.toNFT(remoteNFT)
    let order: Order | undefined

    if (remoteOrder) {
      order = this.toOrder(remoteOrder, oneEthInMANA)

      nft.activeOrderId = order.id
    }

    return [nft, order] as const
  }

  async transfer(
    wallet: Wallet | null,
    toAddress: string,
    nft: NFT<VendorName.SUPER_RARE>
  ) {
    if (!wallet) {
      throw new Error('Invalid address. Wallet must be connected.')
    }
    const from = wallet.address
    const to = toAddress

    const erc721 = ERC721__factory.connect(
      nft.contractAddress,
      await getSigner()
    )
    const transferType = new ContractService().getTransferType(
      nft.contractAddress
    )
    let transaction

    switch (transferType) {
      case TransferType.TRANSFER:
        transaction = await erc721.transfer(to, nft.tokenId)
        break
      case TransferType.SAFE_TRANSFER_FROM:
      default:
        transaction = await erc721.transferFrom(from, to, nft.tokenId)
        break
    }

    return transaction.hash
  }

  toNFT(asset: SuperRareAsset): NFT<VendorName.SUPER_RARE> {
    return {
      id: getNFTId(asset.contractAddress, asset.id.toString()),
      tokenId: asset.id.toString(),
      contractAddress: asset.contractAddress,
      activeOrderId: '',
      owner: asset.owner.address,
      name: asset.name,
      image: asset.image,
      url: asset.url,
      data: {
        description: asset.description
      },
      category: 'art',
      vendor: VendorName.SUPER_RARE,
      chainId: Number(config.get('CHAIN_ID')!),
      network: Network.ETHEREUM,
      issuedId: null,
      itemId: null,
      createdAt: 0,
      updatedAt: 0,
      soldAt: 0
    }
  }

  toOrder(
    order: SuperRareOrder,
    oneEthInMANA: string
  ): Order & { ethPrice: string } {
    const { asset, taker } = order

    const totalWei = this.marketplacePrice.addFee(order.amountWithFee)
    const weiPrice = ethers.BigNumber.from(totalWei).mul(oneEthInMANA)
    const price = weiPrice.div(this.oneEthInWei)

    return {
      id: `${VendorName.SUPER_RARE}-order-${asset.id}`,
      tokenId: asset.id.toString(),
      contractAddress: asset.contractAddress,
      marketplaceAddress: order.marketContractAddress,
      owner: asset.owner.address,
      buyer: taker ? taker.address : null,
      price: price.toString(),
      ethPrice: order.amountWithFee.toString(),
      status: ListingStatus.OPEN,
      createdAt: +order.timestamp,
      updatedAt: +order.timestamp,
      expiresAt: Infinity,
      chainId: Number(config.get('CHAIN_ID')!),
      network: Network.ETHEREUM
    }
  }

  toAccount(account: SuperRareOwner): Account {
    return {
      id: account.address,
      address: account.address,
      nftIds: []
    }
  }

  private async getOneEthInMANA() {
    const mana = await this.tokenConverter.marketEthToMANA(1)
    return ethers.utils.parseEther(mana.toString())
  }
}
