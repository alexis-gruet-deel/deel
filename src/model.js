const Sequelize = require('sequelize');
const { Op, literal } = require("sequelize");

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite3'
});

class Profile extends Sequelize.Model {

  async getContractById(id) {
    let contract = {};
    //security, double we reallly get contract from either client or contractor. 
    if (this.type == 'client' || this.type == 'contractor') {
      contract = Contract.findOne({
        where: {
          id: id
        },
        include: {
          model: Profile,
          required: true,
          attributes: [], //don't need to fetch fields from profile. 
          as: this.getProfileTypeAssociationAlias(),
          where: { id: this.id }
        }
      })
    }
    return contract;
  }

  async getContracts() {
    let contracts = {};
    //security, to ensure we are not fetching something else. 
    if (this.isClient() || this.isContractor()) {
      let options = {
        where:
        {
          [Op.or]: [
            { status: 'new' },
            { status: 'in_progress' }
          ]
        },
        include: {
          model: Profile,
          required: true,
          attributes: [],
          as: this.getProfileTypeAssociationAlias(),
          where: { id: this.id }
        }
      }
      contracts = Contract.findAll(options);
    }
    return contracts;
  }

  async getAllActiveAndUnPaidJobs() {
    let jobs = {};
    //security, to ensure we are not fetching something else. 
    if (this.isClient() || this.isContractor()) {
      //This may be slow.. too much nested innerjoin.. 
      jobs = Job.findAll({
        include: {
          model: Contract,
          attributes: [], //we don't need these columns. 
          required: true,
          where: {
            [Op.or]: [
              { status: 'new' },
              { status: 'in_progress' }
            ]
          },
          include: {
            model: Profile,
            attributes: [], //we don't need these columns. 
            required: true,
            as: this.getProfileTypeAssociationAlias(),
            where: { id: this.id }
          }
        },
        where: {
          paid: {
            [Op.eq]: false //Had to fix the seedDb.js fixtures to make it works. 
          }
        }
      })
    }
    return jobs;
  }

  async deposit(amount) {
    const retval = { status: false, msg: "" };
    //Assume only a client is supposed to do that. 
    if (this.isClient()) {
      //Let's just map and reduce based on existing request and compute the sum of unpaid job for this profile. 
      const sumOfUNpaidJobs = ((await this.getAllActiveAndUnPaidJobs()).map((i) => i.price)).reduce((sum, i) => sum + i);
      const newBalance = this.balance + parseInt(amount);

      //Deposit max represent 25% of the unpaid job
      if ((amount / sumOfUNpaidJobs) <= 0.25) {
        const t = await sequelize.transaction();
        try {
          //update
          if (!await this.update({ balance: newBalance }, { transaction: t }))
            throw new Error("can't update the client balance with the new deposit");

          //commit
          await t.commit();

          retval.status = true;
          retval.msg = "sucessfully deposited to client"

        } catch (error) {
          retval.msg = error.msg;
          // If the execution reaches this line, an error was thrown.
          // We rollback the transaction.
          await t.rollback();
        }
      } else {
        retval.msg = "exceed 25% of the unpaid Jobs to pay : $" + sumOfUNpaidJobs
      }
    }
    return retval;
  }

  async payContractorByJobId(jobId) {
    //Return object. 
    let txRet = {
      paid: false,
      tx: {}
    };

    const contractorToPay = await this.getContractorToPayByJobId(jobId);
    if (contractorToPay) {

      const price = contractorToPay.price;
      const ContractorId = contractorToPay.Contract.ContractorId;
      const ClientId = this.id;
      const ClientPreviousBalance = this.balance;
      const newClientBalance = this.balance - price;
      const newContractorBalance = contractorToPay.Contract.Contractor.balance + price;

      //Assuming the Client Balance can't reach 0.. 
      if (newClientBalance < 0) {
        throw new Error("balance can't be negative");
      }
      //start unmanaged transaction. 
      const t = await sequelize.transaction();
      try {
        //client balance 
        if (!await this.update({ balance: newClientBalance }, { transaction: t }))
          throw new Error("can't update the client balance");
        //update the contractor ba
        if (!await Profile.update({ balance: newContractorBalance }, { where: { id: ContractorId }, transaction: t }))
          throw new Error("can't update the contractor balance");
        //update the Job to be paid
        if (!await Job.update({ paid: true }, { where: { id: jobId }, transaction: t }))
          throw new Error("can't update the job status");
        //commit
        await t.commit();

        txRet = {
          paid: true,
          tx: {
            ClientName : this.fullName,
            ContractorId: contractorToPay.Contract.Contractor.fullName,
            ClientPreviousBalance: ClientPreviousBalance,
            ClientNewBalance: newClientBalance,
            ContractorPreviousBalance: contractorToPay.Contract.Contractor.balance,
            ContractorNewBalance: newContractorBalance,
            ClientPaidToContractor: price,
            Msg: "done"
          }
        }

      } catch (error) {
        // If the execution reaches this line, an error was thrown.
        // We rollback the transaction.
        await t.rollback();
        txRet.tx.Msg = error.toString()
      }
    }
    return txRet;
  }

  async getContractorToPayByJobId(jobId) {
    let retval = false;
    if (jobId && this.isClient()) {
      retval = Job.findOne({
        include: {
          model: Contract,
          required: true,
          include: {
            model: Profile,
            as: 'Contractor',
            required: true
          }
        },
        where: {
          id: jobId,
          paid: false,
          price: {
            [Op.lte]: this.balance
          }
        }
      });
    }
    return retval;
  }

  isClient() {
    return this.type == 'client' ? true : false
  }

  isContractor() {
    return this.type == 'contractor' ? true : false
  }

  getProfileTypeAssociationAlias() {
    return Profile.capitalizeFirstLetter(this.type);
  }

  static capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
  }
}

Profile.init(
  {
    firstName: {
      type: Sequelize.STRING,
      allowNull: false
    },
    lastName: {
      type: Sequelize.STRING,
      allowNull: false
    },
    //Implemented, but issue found in Job::getTopPaidClientsByDateRange
    fullName: {
      type: Sequelize.VIRTUAL(Sequelize.STRING, ['firstName', 'lastName']),
      get() {
        return `${this.firstName} ${this.lastName}`;
      },
      set(value) {
        throw new Error('Do not try to set the `fullName` value!');
      }
    },
    profession: {
      type: Sequelize.STRING,
      allowNull: false
    },
    balance: {
      type: Sequelize.DECIMAL(12, 2)
    },
    type: {
      type: Sequelize.ENUM('client', 'contractor')
    }
  },
  {
    sequelize,
    modelName: 'Profile'
  }
);

class Contract extends Sequelize.Model { }
Contract.init(
  {
    terms: {
      type: Sequelize.TEXT,
      allowNull: false
    },
    status: {
      type: Sequelize.ENUM('new', 'in_progress', 'terminated')
    }
  },
  {
    sequelize,
    modelName: 'Contract'
  }
);

class Job extends Sequelize.Model {

  //get the clients the most paid
  static async getTopPaidClientsByDateRange(startedDate, endDate, limit) {
    const topClients = await Job.findAll({
      attributes: [
        // This not work even defined in the Profile class. 
        // Inside attributes, turns out sequelize.col handle only real column and not virtual
        // [sequelize.col('Contract.Client.fullName'), 'fullName'],
        [sequelize.col('Contract.Client.id'), 'id'],
        [sequelize.fn('sum', sequelize.col('price')), 'paid']
      ],
      group: ['ContractId'],
      order: [
        ['paid', 'DESC']
      ],
      where: {
        paid: true,
        paymentDate: {
          [Op.between]: [startedDate, endDate]
        }
      },
      limit: limit,
      include: {
        model: Contract,
        required: true,
        include: {
          model: Profile,
          required: true,
          as: 'Client'
        }
      }
    })

    //A Map as per the Readme.. This was required to 1) workaround not working attributes->fullName (see above) 
    //and 2) avoid writing native SQL query.. cautious of time.. 
    return topClients.map(i => {
      const retval = {};
      retval.id = i.id;
      retval.fullName = i.Contract.Client.firstName + " " + i.Contract.Client.lastName;
      retval.paid = i.paid;
      return retval;
    })
  }

  //get the Top revenue jobs
  static async getTopRevenueJobsByDateRange(startedDate, endDate) {
    const topJobs = await Job.findAll({
      attributes: [
        [Sequelize.col('Contract.Contractor.profession'), 'profession'],
        [sequelize.fn('sum', sequelize.col('price')), 'paid']
      ],
      group: ['ContractId'],
      order: [
        ['paid', 'DESC'],
      ],
      where: {
        paid: true,
        paymentDate: {
          [Op.between]: [startedDate, endDate]
        }
      },
      limit: 1,
      include: {
        model: Contract,
        required: true,
        attributes: [],
        include: {
          model: Profile,
          required: true,
          as: 'Contractor',
          attributes: []
        }
      }
    })
    return topJobs

  }
}

Job.init(
  {
    description: {
      type: Sequelize.TEXT,
      allowNull: false
    },
    price: {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: false
    },
    paid: {
      type: Sequelize.BOOLEAN,
      default: false
    },
    paymentDate: {
      type: Sequelize.DATE
    }
  },
  {
    sequelize,
    modelName: 'Job'
  }
);

Profile.hasMany(Contract, { as: 'Contractor', foreignKey: 'ContractorId' })
Contract.belongsTo(Profile, { as: 'Contractor' })
Profile.hasMany(Contract, { as: 'Client', foreignKey: 'ClientId' })
Contract.belongsTo(Profile, { as: 'Client' })
Contract.hasMany(Job)
Job.belongsTo(Contract)

module.exports = {
  sequelize,
  Profile,
  Contract,
  Job
};
